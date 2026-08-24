/**
 * Everything about a bulk request that can be decided BEFORE any generation
 * starts — and therefore everything that must still be answered synchronously
 * now that the work itself runs on the queue.
 *
 * ── Why this is its own module ──────────────────────────────────────────────
 *
 * These checks used to live inside `bulkGeneratePosts`, which was fine while the
 * route ran the batch inline: one call, one answer, a 422 for a malformed
 * request. Moving generation to a worker split those apart. If the route only
 * enqueued, a request asking for eleven posts, or a period that started last
 * week, or a content mix that does not add up would be accepted with a 202 and
 * then fail in a worker log — and the person who typed it would be watching a
 * progress bar for a job that was never going to write anything.
 *
 * So the rules live here and BOTH ends call them: the enqueue path, so a bad
 * request is refused while there is still an HTTP response to refuse it with,
 * and the service itself, so a payload that reached a worker by some other route
 * is still checked before it spends anything. Neither re-states a rule.
 *
 * ── What deliberately is NOT here ───────────────────────────────────────────
 *
 * Anything that depends on the state of the world at generation time: whether
 * the article pool still has something unused in it, whether a source ran dry
 * mid-run, whether the LLM is reachable, whether a candidate came back a
 * duplicate. Those are outcomes, not request errors — they are reported per
 * topic and per channel while the batch runs, and a request that hits one is not
 * a request that was wrong. Pulling any of them forward would mean answering
 * "will this work?" before trying, which is exactly the question this feature
 * cannot answer in advance.
 *
 * The two database reads here are the narrow exceptions that prove it, and both
 * qualify for the same reason — they are facts about the REQUEST, fixed before
 * the run and not changed by it:
 *
 *   • a content mix names source IDS, and whether those are this company's and
 *     enabled is settled the moment the request is written;
 *   • an EVEN distribution is entirely a function of the channel's saved posting
 *     windows, so a channel with none makes the request unanswerable rather than
 *     merely unlucky. Trying cannot change that answer, and the run would have
 *     nothing to schedule. See `NO_POSTING_WINDOWS`.
 */

import { prisma } from "@/lib/db/client";
import type { ManualContentSourceRef } from "@/lib/ai/manual-content-source";
import type { SocialChannel } from "@prisma/client";
import { COMPANY_CONTENT_SOURCE_ID } from "@/lib/scheduling/content-mix";
import { hasPostingWindows } from "@/lib/scheduling/posting-windows";
import {
  MAX_BULK_POSTS,
  MAX_BULK_RANGE_DAYS,
  inclusiveDayCount,
  isStartDateInPast,
  validateCustomDistribution,
  type BulkCustomDay,
  type CustomDistributionError,
} from "@/lib/scheduling/bulk-schedule";

/** One line of a per-batch content mix. */
export interface BulkSourceQuota {
  /** null = company content: written from the brand profile, with no article. */
  sourceId: string | null;
  /** How many TOPICS of this batch this source writes. At least 1. */
  posts: number;
}

/**
 * The request-shape rejections. Unchanged from when these lived in the service —
 * they are a published API contract, and the whole point of this extraction is
 * that a caller cannot tell the difference.
 */
export type BulkRequestErrorCode =
  | "INVALID_POST_COUNT"
  | "INVALID_DATE_RANGE"
  | "START_DATE_IN_PAST"
  | "INVALID_DISTRIBUTION"
  /**
   * An EVEN distribution was asked for over a channel that has no posting
   * schedule, so there is no time of day to spread the posts across.
   *
   * A request error rather than a runtime outcome, and squarely inside this
   * module's remit: it is fixed before the run, decided entirely by the request
   * and the channel's saved configuration, and the answer cannot change by
   * trying. The alternative — planning nothing and reporting a "successful batch
   * of zero" — tells the person who clicked Generate nothing they can act on.
   *
   * Deliberately NOT raised for a custom distribution: there the user names every
   * time, which is precisely the other way out of this. See
   * lib/scheduling/bulk-schedule.ts.
   */
  | "NO_POSTING_WINDOWS"
  | "INVALID_SOURCE_MIX";

export interface BulkRequestProblem {
  code: BulkRequestErrorCode;
  /** English, for logs and API consumers; the UI translates `code`. */
  message: string;
}

/** The parts of a bulk request these rules are about. */
export interface BulkRequestShape {
  /**
   * Every channel each topic is written for.
   *
   * Read only by the posting-window check, which is per channel: each one plans
   * its own slots from its own schedule, so one unconfigured channel in a
   * multi-channel batch is enough to make the request unanswerable.
   */
  channels: readonly string[];
  /** How many content TOPICS to write. */
  numberOfPosts: number;
  /** Inclusive `YYYY-MM-DD`, a business-zone calendar day. */
  startDate: string;
  /** Inclusive `YYYY-MM-DD`, a business-zone calendar day. */
  endDate: string;
  /** A user-authored schedule, when the user chose one. */
  customDistribution?: BulkCustomDay[];
  /** The form's "Content source" choice. */
  contentSource?: ManualContentSourceRef;
  /** A per-batch content mix, when the user chose one. */
  sourceMix?: BulkSourceQuota[];
}

/**
 * English wording for each way a custom distribution can be wrong.
 *
 * The form runs the very same `validateCustomDistribution` before it lets the
 * user submit, so in practice none of these are ever seen — they exist because
 * the server does not take the client's word for the schedule.
 */
const DISTRIBUTION_MESSAGES: Record<CustomDistributionError, string> = {
  empty: "Choose at least one date to publish on.",
  invalid_date: "One of the chosen dates is not a valid date.",
  duplicate_date: "The same date was listed more than once.",
  out_of_period: "Every chosen date must fall inside the start and end dates.",
  invalid_count: "Each chosen date must carry at least one whole post.",
  count_mismatch: "The posts assigned to the chosen dates must add up to the number requested.",
  invalid_time: "One of the chosen publishing times is not a valid time of day.",
  time_count_mismatch: "Each chosen date must have one publishing time per post assigned to it.",
  duplicate_slot: "Two posts were given the same date and time.",
  time_in_past: "Every chosen publishing time must be in the future.",
};

/**
 * Every rule that needs nothing but the request and a clock. PURE.
 *
 * Ordered exactly as it always has been — count, then range, then start date,
 * then distribution — because a request that is wrong in two ways has always
 * been told about the first, and a caller may reasonably have built on that.
 */
export function validateBulkRequestShape(
  input: BulkRequestShape,
  now: Date
): BulkRequestProblem | null {
  if (
    !Number.isInteger(input.numberOfPosts) ||
    input.numberOfPosts < 1 ||
    input.numberOfPosts > MAX_BULK_POSTS
  ) {
    return {
      code: "INVALID_POST_COUNT",
      message: `Number of posts must be a whole number between 1 and ${MAX_BULK_POSTS}.`,
    };
  }

  if (inclusiveDayCount(input.startDate, input.endDate) === null) {
    return {
      code: "INVALID_DATE_RANGE",
      message: `The end date must be a valid date on or after the start date, and at most ${MAX_BULK_RANGE_DAYS} days later.`,
    };
  }

  // A period that has already begun would schedule posts into the past, and a
  // post scheduled into the past is one the publisher will refuse to fire — so
  // it is refused here, where it is still a request rather than a batch of
  // stranded drafts. The form applies the same rule to its own date input.
  if (isStartDateInPast(input.startDate, now)) {
    return { code: "START_DATE_IN_PAST", message: "The start date must be today or later." };
  }

  if (input.customDistribution !== undefined) {
    const problem = validateCustomDistribution(
      input.customDistribution,
      input.numberOfPosts,
      input.startDate,
      input.endDate,
      now
    );
    if (problem !== null) {
      return { code: "INVALID_DISTRIBUTION", message: DISTRIBUTION_MESSAGES[problem] };
    }
  }

  return null;
}

/**
 * Why a submitted per-batch mix cannot be run, in English, or null when it can.
 *
 * PURE — the caller supplies the company's enabled source ids. The form applies
 * every one of these before it enables the button; they are repeated here
 * because the server does not take the client's word for where posts come from.
 * The sum rule is the load-bearing one: the mix IS the batch, so a mix that does
 * not add up to the number requested would silently generate a different number
 * of topics than the button promised.
 */
export function validateSourceMix(
  mix: readonly BulkSourceQuota[],
  numberOfPosts: number,
  contentSource: ManualContentSourceRef | undefined,
  enabledSourceIds: ReadonlySet<string>
): string | null {
  // The two ways of choosing a source are alternatives, not layers: a specific
  // pick means "every post from here", a mix means "these posts from each of
  // these". Letting both through would leave the answer to whichever the loop
  // happened to read.
  if (contentSource !== undefined && contentSource.kind !== "company_rules") {
    return "A content mix and a single content source cannot both be chosen for one batch.";
  }

  if (mix.length === 0) {
    return "A content mix must name at least one source.";
  }

  const seen = new Set<string | null>();
  for (const quota of mix) {
    if (seen.has(quota.sourceId)) {
      return "The same content source is listed more than once in the mix.";
    }
    seen.add(quota.sourceId);

    if (!Number.isInteger(quota.posts) || quota.posts < 1) {
      return "Every source in the mix must be given a whole number of one post or more.";
    }

    if (quota.sourceId !== COMPANY_CONTENT_SOURCE_ID && !enabledSourceIds.has(quota.sourceId)) {
      return "The mix names a content source that does not exist or is not enabled.";
    }
  }

  const total = mix.reduce((sum, q) => sum + q.posts, 0);
  if (total !== numberOfPosts) {
    return `The content mix assigns ${total} posts but ${numberOfPosts} were requested.`;
  }

  return null;
}

/**
 * The ids a per-batch mix may name: this company's ENABLED content sources.
 *
 * Scoped by slug only. These ids are only ever compared against what the request
 * submitted, and the generation calls that follow are what enforce membership —
 * a wrong answer here could only affect a mix naming sources the run was never
 * going to be allowed to use. Disabled sources are excluded because the stored
 * mix excludes them too (`resolveContentMix` drops them), so a mix naming one is
 * a stale client, not a valid instruction.
 */
export async function loadEnabledSourceIdsFromDb(slug: string): Promise<Set<string>> {
  const rows = await prisma.contentSource.findMany({
    where: { company: { slug }, enabled: true },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

const SOCIAL_CHANNELS = ["facebook", "linkedin", "instagram", "tiktok"] as const;

function isSocialChannel(value: string): value is SocialChannel {
  return (SOCIAL_CHANNELS as readonly string[]).includes(value);
}

/**
 * A channel's `postingWindows` as stored, or null when there is no such channel.
 *
 * Shared with `bulkGeneratePosts`, which plans the actual slots from the very
 * same read — one answer to "when does this channel publish?", so the check that
 * refuses the request and the planner that would have run it cannot disagree.
 *
 * An unknown channel is not rejected here — generation owns that answer
 * (INVALID_CHANNEL). This only has to avoid handing Prisma a value its enum does
 * not accept. Scoped by slug only: the value is a time of day, and the
 * generation calls that follow are what enforce membership.
 */
export async function loadPostingWindowsFromDb(slug: string, channel: string): Promise<unknown> {
  const normalized = channel.toLowerCase();
  if (!isSocialChannel(normalized)) return null;

  const config = await prisma.channelConfig.findFirst({
    where: { company: { slug }, channel: normalized },
    select: { postingWindows: true },
  });
  return config?.postingWindows ?? null;
}

export interface ValidateBulkRequestDeps {
  /** The company's enabled content-source ids — what a submitted mix is checked against. */
  loadEnabledSourceIds?: (slug: string) => Promise<Set<string>>;
  /** A channel's saved posting windows — what the even-distribution check reads. */
  loadPostingWindows?: (slug: string, channel: string) => Promise<unknown>;
}

/**
 * The whole request-shape check: the pure rules, then the posting schedule, then
 * the content mix.
 *
 * The database is touched only for the two checks that need it — an even
 * distribution reads each channel's windows, a submitted mix reads the company's
 * sources — so a custom-distribution request with no mix stays a pure function
 * call.
 */
export async function validateBulkRequest(
  slug: string,
  input: BulkRequestShape,
  now: Date,
  deps: ValidateBulkRequestDeps = {}
): Promise<BulkRequestProblem | null> {
  const shapeProblem = validateBulkRequestShape(input, now);
  if (shapeProblem !== null) return shapeProblem;

  // Even distribution only. The channel's posting windows are the ONLY thing
  // that decides the days and times in that mode, so a channel without any has
  // nothing to be distributed over — and inventing an hour for it is exactly
  // what this application no longer does, on the manual path or the automatic
  // one. Custom mode skips this: the user has named every time already.
  if (input.customDistribution === undefined) {
    const loadPostingWindows = deps.loadPostingWindows ?? loadPostingWindowsFromDb;
    const unscheduled: string[] = [];

    for (const channel of input.channels) {
      if (!hasPostingWindows(await loadPostingWindows(slug, channel))) unscheduled.push(channel);
    }

    if (unscheduled.length > 0) {
      return {
        code: "NO_POSTING_WINDOWS",
        // Names the channels, because in a multi-channel batch the fix is
        // per channel and the user cannot otherwise tell which one to open.
        message:
          `No publishing times are configured for ${unscheduled.join(", ")}. ` +
          "Add a posting schedule in channel settings, or choose the date and time of each post yourself.",
      };
    }
  }

  if (input.sourceMix === undefined) return null;

  const loadEnabledSourceIds = deps.loadEnabledSourceIds ?? loadEnabledSourceIdsFromDb;
  // An unknown id is refused rather than skipped: it would otherwise fail
  // per-slot, be read as "that source is spent", and quietly move its posts onto
  // sources the user never allocated them to.
  const problem = validateSourceMix(
    input.sourceMix,
    input.numberOfPosts,
    input.contentSource,
    await loadEnabledSourceIds(slug)
  );
  return problem === null ? null : { code: "INVALID_SOURCE_MIX", message: problem };
}
