/**
 * Following a queued bulk generation from the browser.
 *
 * Bulk generation used to be one HTTP request that took minutes and answered
 * with the finished batch. It is now a job: the POST returns 202 with an id, a
 * worker does the work, and the form watches. That swaps one problem — a request
 * that outlives its function timeout — for a different one the UI has to answer
 * honestly:
 *
 *   • 202 is NOT "generated". Nothing has been written when it arrives.
 *   • "queued" and "running" are different facts. A job sits queued because no
 *     worker has claimed it, which — when it lasts — means no worker is running.
 *     That is a thing to TELL someone, not to hide behind the same spinner as
 *     work in progress.
 *   • A finished job's `result` is the batch summary, so the completed state is
 *     rendered from the same object the poll returns, not from a second request.
 *
 * All of it is pure and lives here rather than in the component: these are the
 * decisions worth testing, and none of them need a browser.
 */

import type { BulkBatchResponse } from "./bulk-form";

/** Lifecycle as the status endpoint reports it — mirrors `BulkGenerationJobState`. */
export type BulkJobState = "queued" | "running" | "completed" | "failed" | "cancelled";

/** One channel of one topic that produced nothing. */
export interface BulkJobFailure {
  index?: number;
  scheduledFor?: string;
  channel?: string;
  code: string;
  reason?: string;
  message?: string;
}

/** The batch summary as far as it has got. `BulkGenerationProgress`, over the wire. */
export interface BulkJobProgress {
  batchId: string;
  requested: number;
  generated: number;
  channels?: string[];
  requestedPosts?: number;
  generatedPosts?: number;
  groups?: Array<{
    index: number;
    contentGroupId: string;
    posts: Array<{ index: number; postId: string; channel: string; scheduledFor: string }>;
    failures?: BulkJobFailure[];
  }>;
  liveTopic?: { index: number; contentGroupId: string; completedChannels: string[] };
  failed?: number;
  postIds?: string[];
  posts?: Array<{ index: number; postId: string; scheduledFor: string }>;
  failures?: BulkJobFailure[];
  notAttempted?: number;
  stoppedEarly?: boolean;
  stopReason?: string | null;
  exhaustedSources?: Array<string | null>;
}

/** The body of `GET /companies/[slug]/generate/bulk/[jobId]`, as JSON. */
export interface BulkJobStatus {
  jobId: string;
  state: BulkJobState;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  progress: BulkJobProgress | null;
  lastError: string | null;
}

/**
 * How long a job may sit unclaimed before the UI says so.
 *
 * The worker polls on a few-second interval, so a job that is still queued after
 * a minute is not "about to start" — it is waiting for a process that is not
 * there. This matters more than it normally would: a permanent production worker
 * is a release prerequisite that has not landed yet, so "queued forever" is the
 * expected experience until it does, and an unexplained spinner would read as a
 * bug in generation rather than as infrastructure that is not up.
 */
export const WAITING_FOR_WORKER_MS = 60_000;

/**
 * What the UI actually distinguishes between.
 *
 * `waiting-for-worker` is not a queue state — it is `queued`, held long enough
 * that saying "queued" is no longer the useful thing to say.
 */
export type BulkJobPhase =
  "queued" | "waiting-for-worker" | "running" | "completed" | "failed" | "cancelled";

/**
 * The phase to render, given the job and the clock.
 *
 * The threshold is measured from `createdAt` rather than from when the browser
 * started polling, so a job restored from session storage after a navigation is
 * judged on how long it has REALLY waited — a user who comes back to a job
 * queued ten minutes ago is told the truth immediately, not after another minute
 * of spinner.
 *
 * A requeued job (a failed attempt waiting to be retried) reads as `queued`
 * again, which is accurate: it is once more waiting for a worker to claim it.
 */
export function resolveBulkJobPhase(
  // The lifecycle fields only, so a queued TOPIC generation is judged by exactly
  // this function rather than by a second copy of it. Both status endpoints
  // report the same lifecycle — they differ only in the progress they carry —
  // and "how long has this been queued" is a question about the lifecycle.
  status: { state: BulkJobState; createdAt: string },
  nowMs: number,
  thresholdMs: number = WAITING_FOR_WORKER_MS
): BulkJobPhase {
  if (status.state !== "queued") return status.state;

  const created = Date.parse(status.createdAt);
  if (Number.isNaN(created)) return "queued";
  return nowMs - created >= thresholdMs ? "waiting-for-worker" : "queued";
}

/** Whether there is anything left to poll for. */
export function isTerminalBulkJobPhase(phase: BulkJobPhase): boolean {
  return phase === "completed" || phase === "failed" || phase === "cancelled";
}

/**
 * How long to wait before the next poll.
 *
 * A running job is writing posts one at a time over minutes, so a tight poll
 * buys nothing but requests; a queued one is waiting on a worker that may never
 * come, so it backs off further still. Deliberately not a spinner's cadence —
 * the numbers on screen move at the speed generation actually happens.
 */
export function bulkPollIntervalMs(phase: BulkJobPhase): number {
  if (isTerminalBulkJobPhase(phase)) return 0;
  return phase === "running" ? 3_000 : 5_000;
}

export interface BulkJobCounts {
  /** Topics finished — complete or partial. */
  completedTopics: number;
  /** Topics asked for. */
  totalTopics: number;
  /** Post rows written so far, across every topic and channel. */
  generatedPosts: number;
  /** Channel versions that were attempted and produced nothing. */
  failedChannels: number;
}

/**
 * The numbers behind "3 of 5 topics · 9 posts generated".
 *
 * Derived from `groups` where possible, because that is what has actually been
 * committed; the flat counters are the fallback for a summary written by a
 * version that did not record groups. A job with no progress yet is all zeros
 * rather than null, so the caller renders "0 of 5" instead of branching.
 *
 * `totalTopics` falls back to `requestedTopics` — what the form asked for — so
 * the denominator is right from the first render, before any progress exists.
 */
export function summarizeBulkJob(
  progress: BulkJobProgress | null,
  requestedTopics = 0
): BulkJobCounts {
  if (!progress) {
    return {
      completedTopics: 0,
      totalTopics: requestedTopics,
      generatedPosts: 0,
      failedChannels: 0,
    };
  }

  const groups = progress.groups ?? [];
  const generatedPosts =
    progress.generatedPosts ?? groups.reduce((sum, g) => sum + g.posts.length, 0);

  // Every channel that was tried and produced nothing, wherever it was recorded:
  // per group while the run is in flight, and at the top level in the finished
  // summary. Counted from whichever is present rather than added together, so a
  // summary carrying both does not double.
  const failedChannels =
    groups.length > 0
      ? groups.reduce((sum, g) => sum + (g.failures?.length ?? 0), 0)
      : (progress.failures?.length ?? 0);

  return {
    completedTopics: groups.length > 0 ? groups.length : progress.generated,
    totalTopics: progress.requested || requestedTopics,
    generatedPosts,
    failedChannels,
  };
}

/**
 * The post ids this run has committed so far.
 *
 * Used to decide whether the grid is worth refreshing: a poll that reports no
 * new posts should not trigger a server round trip. Reads the groups rather than
 * `postIds`, which only a finished summary has.
 */
export function committedPostCount(progress: BulkJobProgress | null): number {
  if (!progress) return 0;
  const groups = progress.groups ?? [];
  if (groups.length > 0) return groups.reduce((sum, g) => sum + g.posts.length, 0);
  return progress.postIds?.length ?? progress.generatedPosts ?? 0;
}

/**
 * A finished job's progress, as the batch summary the result panel already
 * knows how to render.
 *
 * The two are the same object — `BulkGenerationSummary` is what the service
 * writes into `jobs.result`, and `BulkBatchResponse` is what the synchronous
 * route used to answer with — so this fills in the fields a mid-flight snapshot
 * has not written yet rather than converting between two designs. Reusing the
 * existing panel is the point: a queued run and the old inline run report the
 * same way, with the same wording, because they are the same summary.
 *
 * Null when there is no progress at all, which is a job that failed before it
 * committed anything; the caller shows the job-level error instead.
 */
export function toBulkBatchResponse(progress: BulkJobProgress | null): BulkBatchResponse | null {
  if (!progress) return null;

  const groups = progress.groups ?? [];
  const posts =
    progress.posts ??
    groups.flatMap((g) =>
      g.posts.map((p) => ({ index: p.index, postId: p.postId, scheduledFor: p.scheduledFor }))
    );
  const failures = progress.failures ?? groups.flatMap((g) => g.failures ?? []);

  return {
    batchId: progress.batchId,
    requested: progress.requested,
    generated: progress.generated,
    failed: progress.failed ?? Math.max(0, progress.requested - progress.generated),
    postIds: progress.postIds ?? posts.map((p) => p.postId),
    posts,
    failures: failures.map((f) => ({
      index: f.index ?? 0,
      scheduledFor: f.scheduledFor ?? "",
      code: f.code,
      // The coarse grouping the result panel names its explanation from. Absent
      // only on a failure recorded before the field existed, where "unknown" is
      // the honest answer and the panel already has wording for it.
      reason: f.reason ?? "",
      message: f.message ?? "",
    })),
    notAttempted: progress.notAttempted ?? 0,
    stoppedEarly: progress.stoppedEarly ?? false,
    stopReason: toStopReason(progress.stopReason),
    exhaustedSources: progress.exhaustedSources ?? [],
  };
}

/** The stop reasons the result panel has wording for; anything else is dropped. */
function toStopReason(value: string | null | undefined): BulkBatchResponse["stopReason"] {
  return value === "generation_failed" || value === "time_budget" || value === "mix_exhausted"
    ? value
    : null;
}
