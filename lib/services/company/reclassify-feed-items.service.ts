import { prisma } from "@/lib/db/client";
import { enqueueJob, type EnqueueJobResult } from "@/lib/services/queue/enqueue-job.service";
import { RSS_CLASSIFICATION_JOB_TYPE, RSS_CLASSIFICATION_DEDUPE_KEY } from "@/lib/queue/job-types";
import { topicsFingerprint } from "@/lib/ai/feed-item-classification";
import type { TopicPriorities } from "@/lib/ai/topic-priorities";
import { resolveBrandGuidelinesAccess } from "./update-brand-guidelines.service";

/**
 * Reclassification — the ONE place anything reopens articles for a fresh verdict.
 *
 * Three callers converge here (a Brand Settings save, the manual "Reclassify
 * articles" button, and the ingest follow-up), and they differ only in what they
 * pass. Centralised rather than duplicated because the eligibility rule is the
 * part that must never drift: get it wrong in one caller and either consumed
 * history is rewritten or a company's queue silently never reopens.
 *
 * Nothing here calls a model. It flips rows back to `pending` and enqueues the
 * existing drain — the same job type, the same dedupe key, the same worker
 * handler as every other trigger. A settings save is an HTTP request and must
 * never wait on an LLM.
 */

/**
 * Which articles may be reopened.
 *
 *   • `usedInPost: false` — the same filter generation uses to find candidates,
 *     so "still worth judging" and "still a candidate" stay one definition. An
 *     article already written from is HISTORY: its verdict recorded a decision
 *     made under the configuration in force at the time, and rewriting it would
 *     make the post's own record disagree with itself.
 *   • an enabled RSS source — the only kind that carries a verdict at all.
 *   • a SETTLED status — `completed`, `skipped` or `failed`. `pending` is already
 *     queued and `classifying` is in flight behind a live lease; touching either
 *     would either be a no-op or would yank an item out from under a running
 *     drain. Both are picked up by the drain regardless.
 *
 * `classificationStatus: null` is deliberately excluded too: it means the feature
 * does not apply to this row (a non-RSS source, or a row from before the column
 * existed), and ingestion is what opens those.
 */
const RECLASSIFIABLE_STATUSES = ["completed", "skipped", "failed"] as const;

/**
 * The eligibility predicate, exported so the rule above is a test rather than a
 * comment — it is the one part of this file that must never drift.
 */
export function reclassifiableWhere(companyId: string): Record<string, unknown> {
  return {
    companyId,
    usedInPost: false,
    source: { enabled: true, type: "rss" },
    classificationStatus: { in: [...RECLASSIFIABLE_STATUSES] },
  };
}

export interface ReclassifyResult {
  /** Rows flipped back to `pending`. Zero means there was nothing stale. */
  reopened: number;
  /** Null when nothing was reopened, so no drain was asked for. */
  enqueued: EnqueueJobResult | null;
}

export interface ReclassifyDeps {
  /** Flips eligible rows to pending; returns how many. */
  reopen?: (companyId: string) => Promise<number>;
  enqueue?: () => Promise<EnqueueJobResult>;
}

async function defaultReopen(companyId: string): Promise<number> {
  const result = await prisma.feedItem.updateMany({
    where: reclassifiableWhere(companyId),
    data: {
      classificationStatus: "pending",
      // A fresh question deserves a fresh budget — otherwise an item that
      // exhausted its retries against the old configuration could never be
      // judged against the new one.
      classificationAttemptCount: 0,
      classificationError: null,
      classificationLeaseExpiresAt: null,
    },
  });
  return result.count;
}

function defaultEnqueue(): Promise<EnqueueJobResult> {
  return enqueueJob({
    type: RSS_CLASSIFICATION_JOB_TYPE,
    // The SHARED key, on purpose: a settings save, a manual click and the
    // translation tick finishing together collapse into one drain rather than
    // racing over the same articles. A deduplicated enqueue loses nothing — the
    // run already in flight re-derives its work from the rows.
    dedupeKey: RSS_CLASSIFICATION_DEDUPE_KEY,
    // Above the recurring sweeps: somebody changed a setting and is waiting to
    // see what it did.
    priority: 5,
  });
}

/**
 * Reopens a company's stale verdicts and asks for a drain.
 *
 * Idempotent in the way that matters. Running it twice reopens the same rows a
 * second time (cheap, and the second `updateMany` matches only what the drain has
 * not yet settled), and the second enqueue is absorbed by the dedupe key. Crucially,
 * an item whose text and topic configuration have not actually changed still costs
 * NO model call: the drain recomputes `classificationHash`, finds it unchanged, and
 * settles the row straight back to `completed`. That is what lets this be triggered
 * bluntly without auditing exactly which topic moved.
 */
export async function reclassifyCompanyFeedItems(
  companyId: string,
  deps: ReclassifyDeps = {}
): Promise<ReclassifyResult> {
  const reopen = deps.reopen ?? defaultReopen;
  const enqueue = deps.enqueue ?? defaultEnqueue;

  const reopened = await reopen(companyId);
  if (reopened === 0) return { reopened: 0, enqueued: null };

  return { reopened, enqueued: await enqueue() };
}

export type RequestReclassificationResult =
  | { success: true; reopened: number; enqueued: boolean; deduplicated: boolean }
  | { success: false; code: "NOT_FOUND" | "FORBIDDEN" };

export interface RequestReclassificationDeps extends ReclassifyDeps {
  resolveAccess?: typeof resolveBrandGuidelinesAccess;
}

/**
 * The manual "Reclassify articles" action.
 *
 * Same authorization as editing the topics themselves — owners and global admins
 * — because it is the same setting being applied, and a non-member gets NOT_FOUND
 * rather than FORBIDDEN so the response cannot confirm the company exists.
 *
 * Unlike the settings hook this does NOT compare fingerprints: the button exists
 * precisely for the cases a fingerprint cannot see (a classification that failed
 * against a dead provider, an item stuck behind a crashed worker, a verdict an
 * operator simply distrusts), so it always reopens. That costs nothing when
 * nothing really changed — the drain recomputes the hash, finds it unchanged, and
 * settles each row without a model call.
 *
 * It enqueues the existing drain and returns; no LLM call happens in the request.
 */
export async function requestReclassification(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean,
  deps: RequestReclassificationDeps = {}
): Promise<RequestReclassificationResult> {
  const resolveAccess = deps.resolveAccess ?? resolveBrandGuidelinesAccess;

  const access = await resolveAccess(slug, userId, isGlobalAdmin);
  if (!access.ok) return { success: false, code: access.code };

  const result = await reclassifyCompanyFeedItems(access.companyId, deps);

  console.info("[classification] manual reclassification requested", {
    companyId: access.companyId,
    reopened: result.reopened,
    enqueued: result.enqueued?.enqueued ?? false,
    deduplicated: result.enqueued?.deduplicated ?? false,
  });

  return {
    success: true,
    reopened: result.reopened,
    enqueued: result.enqueued?.enqueued ?? false,
    deduplicated: result.enqueued?.deduplicated ?? false,
  };
}

/**
 * Whether a topic-configuration change is worth reopening anything for.
 *
 * Compares FINGERPRINTS, not lists: normalized, deduplicated and sorted, so
 * reordering chips in the form, re-typing a topic with different capitalisation,
 * or saving the Brand Settings page without touching topics at all is correctly
 * seen as no change and costs nothing. Adding, removing or genuinely editing a
 * topic is a change and reopens.
 */
export function topicPrioritiesChanged(before: TopicPriorities, after: TopicPriorities): boolean {
  return topicsFingerprint(before) !== topicsFingerprint(after);
}

/**
 * The Brand Settings hook: reclassify iff the topics really moved. Best-effort —
 * a save must never fail because the queue was briefly unreachable, and the
 * translation tick re-enqueues the drain anyway.
 */
export async function reclassifyAfterTopicChange(
  companyId: string,
  before: TopicPriorities,
  after: TopicPriorities,
  deps: ReclassifyDeps = {}
): Promise<ReclassifyResult | null> {
  if (!topicPrioritiesChanged(before, after)) return null;

  try {
    const result = await reclassifyCompanyFeedItems(companyId, deps);
    console.info("[classification] topics changed — articles reopened", {
      companyId,
      reopened: result.reopened,
      enqueued: result.enqueued?.enqueued ?? false,
      deduplicated: result.enqueued?.deduplicated ?? false,
    });
    return result;
  } catch (err) {
    console.error("[classification] reclassification after a topic change failed (ignored)", {
      companyId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
