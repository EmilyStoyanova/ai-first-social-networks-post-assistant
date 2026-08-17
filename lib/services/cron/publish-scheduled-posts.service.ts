import type { Prisma, SocialChannel } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getBufferClient } from "@/lib/buffer/buffer-provider";
import { BufferNoConnectionError, BufferTokenExpiredError } from "@/lib/buffer/buffer-errors";
import { createAuditLog, AUDIT_ACTIONS } from "@/lib/services/audit/audit-log.service";
import {
  PAST_DUE_GRACE_MS,
  PUBLISH_LOOKAHEAD_MS,
  partitionByPublishDecision,
  pastDueMessage,
} from "@/lib/scheduling/publish-window";
import {
  MOCK_BUFFER_POST_ID,
  loadBufferProfileMap,
  markPostFailed,
  markPostSent,
  sendPostToBuffer,
} from "./_send-post";

/** Bounds Buffer API calls per run to stay inside the function timeout. */
const MAX_PUBLISHES_PER_RUN = 10;

export interface PublishScheduledSummary {
  published: number;
  failed: number;
  skipped: number;
  /**
   * Manually scheduled posts whose time went by too long ago to fire silently.
   * They stay `approved` and wait for a person to give them a new time — see
   * lib/scheduling/publish-window.ts.
   */
  pastDue: number;
  reason?: "NO_CONNECTION" | "TOKEN_EXPIRED";
  failures: Array<{ postId: string; message: string }>;
}

/** A row the publisher considers, as read from the database. */
interface PublishableRow {
  id: string;
  channel: SocialChannel;
  content: string;
  hashtags: string[];
  mediaAssetId: string | null;
  mediaAsset: { url: string } | null;
  scheduledFor: Date | null;
  manuallyScheduled: boolean;
  lastError: string | null;
}

export interface PublishScheduledDeps {
  now?: () => Date;
  /** Approved, scheduled posts worth considering this run. */
  loadCandidates?: (companyId: string, now: Date) => Promise<PublishableRow[]>;
  /** Records a past-due post's reason, without changing its status. */
  parkPastDue?: (companyId: string, post: PublishableRow, message: string) => Promise<void>;
  /**
   * Sends the due posts. Injected so the SELECTION rule — which posts a sweep
   * considers due — can be tested without a Buffer connection or a database;
   * production always wires `deliverToBuffer`.
   */
  deliver?: (
    companyId: string,
    posts: PublishableRow[],
    summary: PublishScheduledSummary
  ) => Promise<void>;
}

/**
 * Which posts a sweep at `now` could plausibly act on — the query half of the
 * rule whose decision half is `decidePublish`.
 *
 * The upper bound is the WIDEST any post could need (the cron look-ahead), so
 * the query stays an index-friendly range scan; `partitionByPublishDecision`
 * then applies the real per-post rule.
 *
 * The three branches exist to keep already-parked posts OUT of the read. A
 * parked post stays `approved` with a `scheduledFor` in the past forever, and
 * the scan is ordered oldest-first: without this, a company that accumulated
 * enough stranded posts would fill the row budget with them every sweep and
 * never reach the posts that are actually due — publishing would stop silently.
 * A post is therefore read once to be parked, and not again until someone
 * reschedules it (which clears the note).
 *
 * Exported because the sweep orchestrator (run-publish-cron.service.ts) picks
 * the companies to visit by asking which ones hold a row matching THIS. Two
 * predicates would eventually disagree, and the failure would be silent in the
 * worst direction: a company whose posts are due but which the sweep never
 * selects publishes nothing, and reports nothing either.
 */
export function publishCandidateWhere(now: Date): Prisma.PostWhereInput {
  const graceStart = new Date(now.getTime() - PAST_DUE_GRACE_MS);

  return {
    status: "approved",
    scheduledFor: { not: null, lte: new Date(now.getTime() + PUBLISH_LOOKAHEAD_MS) },
    OR: [
      // Automatic — unchanged: sendable at any age, up to the look-ahead.
      { manuallyScheduled: false },
      // Manual, still inside its grace window: sendable.
      { manuallyScheduled: true, scheduledFor: { gte: graceStart } },
      // Manual, long past due, not yet parked: read so it can be parked once.
      { manuallyScheduled: true, scheduledFor: { lt: graceStart }, lastError: null },
    ],
  };
}

/** Reads the posts this run could plausibly send, for one company. */
async function defaultLoadCandidates(companyId: string, now: Date): Promise<PublishableRow[]> {
  return prisma.post.findMany({
    where: { companyId, ...publishCandidateWhere(now) },
    orderBy: { scheduledFor: "asc" },
    // Read wider than we can send: some of these will be parked or skipped
    // rather than published, and a run that filled its read limit with future
    // posts would starve the due ones behind them.
    take: MAX_PUBLISHES_PER_RUN * 3,
    select: {
      id: true,
      channel: true,
      content: true,
      hashtags: true,
      mediaAssetId: true,
      mediaAsset: { select: { url: true } },
      scheduledFor: true,
      manuallyScheduled: true,
      lastError: true,
    },
  });
}

/**
 * Records that a manually scheduled post missed its slot.
 *
 * Deliberately does NOT change the status. `failed` would hand the post to the
 * retry step, which exists to re-attempt delivery — and re-attempting is exactly
 * what must not happen here. It stays `approved` with an explanation, so the
 * post is intact and one reschedule is all it needs.
 *
 * Idempotent: the message is derived from `scheduledFor`, so a post already
 * carrying it is left completely alone. Without that, the sweep would write an
 * audit entry for the same stranded post on every tick forever — and the finer
 * the sweep interval, the faster that fills the log.
 */
async function defaultParkPastDue(
  companyId: string,
  post: PublishableRow,
  message: string
): Promise<void> {
  if (post.lastError === message) return;

  await prisma.post.update({ where: { id: post.id }, data: { lastError: message } });
  await createAuditLog({
    companyId,
    action: AUDIT_ACTIONS.POST_PUBLISH_SKIPPED,
    entityType: "post",
    entityId: post.id,
    metadata: {
      automated: true,
      reason: "past_due",
      scheduledFor: post.scheduledFor?.toISOString() ?? null,
      manuallyScheduled: post.manuallyScheduled,
    },
  });
}

/**
 * Cron step 5 — sends approved posts to Buffer once they are due.
 *
 * "Due" is decided by lib/scheduling/publish-window.ts, not by this query:
 * automatic posts keep their 48-hour look-ahead, manually scheduled ones wait
 * for the time a person picked, and a manual post whose time is long gone is
 * parked rather than fired late. Connection-level problems (no connection,
 * expired token) skip the whole step without consuming posts' retry budget;
 * per-post errors mark the post failed for the retry step to pick up.
 */
export async function publishScheduledPosts(
  companyId: string,
  deps: PublishScheduledDeps = {}
): Promise<PublishScheduledSummary> {
  const now = (deps.now ?? (() => new Date()))();
  const loadCandidates = deps.loadCandidates ?? defaultLoadCandidates;
  const parkPastDue = deps.parkPastDue ?? defaultParkPastDue;
  const deliver = deps.deliver ?? deliverToBuffer;

  const candidates = await loadCandidates(companyId, now);
  const { due, pastDue } = partitionByPublishDecision(candidates, now);

  const summary: PublishScheduledSummary = {
    published: 0,
    failed: 0,
    skipped: 0,
    pastDue: 0,
    failures: [],
  };

  // Parked first and unconditionally: a stranded post must be reported even in
  // a run that has nothing to send, or a Buffer outage would hide it.
  for (const post of pastDue) {
    await parkPastDue(companyId, post, pastDueMessage(post.scheduledFor as Date));
    summary.pastDue++;
  }

  const posts = due.slice(0, MAX_PUBLISHES_PER_RUN);
  if (posts.length > 0) await deliver(companyId, posts, summary);

  return summary;
}

/**
 * The Buffer half: everything from here down is delivery, unchanged in
 * behaviour from before the due-gate existed. Split out purely so the selection
 * rule above has a seam to be tested through.
 */
async function deliverToBuffer(
  companyId: string,
  posts: PublishableRow[],
  summary: PublishScheduledSummary
): Promise<void> {
  // ── Mock mode ──────────────────────────────────────────────────────────────
  if (process.env.AI_MOCK_MODE === "true") {
    for (const post of posts) {
      await markPostSent(companyId, post.id, MOCK_BUFFER_POST_ID, { mock: true });
      summary.published++;
    }
    return;
  }

  let client: Awaited<ReturnType<typeof getBufferClient>>;
  try {
    client = await getBufferClient(companyId);
  } catch (err) {
    if (err instanceof BufferNoConnectionError) {
      summary.skipped = posts.length;
      summary.reason = "NO_CONNECTION";
      return;
    }
    if (err instanceof BufferTokenExpiredError) {
      summary.skipped = posts.length;
      summary.reason = "TOKEN_EXPIRED";
      return;
    }
    throw err;
  }

  const profileMap = await loadBufferProfileMap(companyId);

  for (const post of posts) {
    const profileId = profileMap.get(post.channel);
    if (!profileId) {
      const message = `No Buffer profile configured for channel ${post.channel}. Set one in the channel settings.`;
      await markPostFailed(companyId, post.id, message, { incrementRetry: false });
      summary.failed++;
      summary.failures.push({ postId: post.id, message });
      continue;
    }

    const outcome = await sendPostToBuffer(client, post, profileId);

    if (outcome.ok) {
      await markPostSent(
        companyId,
        post.id,
        outcome.updateId,
        { channel: post.channel, scheduledFor: post.scheduledFor?.toISOString() ?? null },
        outcome.publishedUrl
      );
      summary.published++;
      continue;
    }

    if (outcome.tokenExpired) {
      // Affects every remaining post equally — abort without burning retries.
      summary.skipped += posts.length - summary.published - summary.failed;
      summary.reason = "TOKEN_EXPIRED";
      return;
    }

    await markPostFailed(companyId, post.id, outcome.message, { incrementRetry: false });
    summary.failed++;
    summary.failures.push({ postId: post.id, message: outcome.message });
  }

  return;
}
