/**
 * Following a queued multi-channel topic generation from the browser.
 *
 * The single-post button used to be one HTTP request that answered with the
 * finished posts. For two or more channels it is now a job: the POST returns 202
 * with an id, a worker writes the channels one at a time, and the form watches.
 *
 * The lifecycle half of that — queued vs. running, when "queued" has lasted long
 * enough to mean "no worker is up", how often to poll — is IDENTICAL to a bulk
 * run and is imported from `bulk-job.ts` rather than restated. What is different,
 * and is what lives here, is the report: a bulk job records post ids and counts,
 * while a topic job records the finished POSTS, so the grid can show a channel's
 * card the moment it commits instead of waiting for the run to end.
 *
 * All of it is pure and lives here rather than in the component: these are the
 * decisions worth testing, and none of them need a browser.
 */

import type { BulkJobPhase, BulkJobState } from "./bulk-job";

/** One channel that produced nothing, with the generator's own diagnostics. */
export interface TopicJobFailure {
  channel: string;
  code: string;
  message?: string;
  reason?: "jaccard_duplicate" | "semantic_duplicate" | "topic_repeated" | string;
  attempts?: number;
}

/** One channel that did. `post` is the finished draft the grid renders. */
export interface TopicJobPost<TPost = unknown> {
  channel: string;
  postId: string;
  scheduledFor?: string | null;
  post?: TPost;
}

/** The run's report as far as it has got. `TopicGenerationProgress`, over the wire. */
export interface TopicJobProgress<TPost = unknown> {
  contentGroupId: string;
  companyId?: string | null;
  /** Channels asked for — the denominator, stable across a resumed attempt. */
  channels?: string[];
  posts?: Array<TopicJobPost<TPost>>;
  failures?: TopicJobFailure[];
  notAttempted?: string[];
}

/** The body of `GET /companies/[slug]/generate/topic/[jobId]`, as JSON. */
export interface TopicJobStatus<TPost = unknown> {
  jobId: string;
  state: BulkJobState;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  progress: TopicJobProgress<TPost> | null;
  lastError: string | null;
}

/** The reference this tab keeps so a navigation cannot lose the run. */
export interface ActiveTopicJob {
  jobId: string;
  /** The group every channel version shares; known from the 202. */
  contentGroupId: string | null;
  /** Channels asked for — the denominator to show before any progress exists. */
  channels: string[];
  /** When this tab started watching. ISO; used only for display. */
  startedAt: string;
}

export interface TopicJobCounts {
  /** Channel versions committed so far. */
  written: number;
  /** Channels asked for. */
  total: number;
  /** Channels that were attempted and produced nothing. */
  failed: number;
}

/**
 * The numbers behind "2 of 3 channels written".
 *
 * `total` falls back to what the form asked for, so the denominator is right
 * from the first render — before any progress exists. A job with no progress yet
 * is zeros rather than null, so the caller renders "0 of 3" instead of branching.
 */
export function summarizeTopicJob(
  progress: TopicJobProgress | null,
  requestedChannels: readonly string[] = []
): TopicJobCounts {
  if (!progress) {
    return { written: 0, total: requestedChannels.length, failed: 0 };
  }
  return {
    written: progress.posts?.length ?? 0,
    // The run's own list wins: a resumed attempt still reports every channel the
    // topic was asked for, whereas the form's copy is only what THIS tab sent.
    total: progress.channels?.length || requestedChannels.length,
    failed: progress.failures?.length ?? 0,
  };
}

/**
 * The posts this run has committed that the caller has not seen yet.
 *
 * Keyed by post id rather than by channel or by count, because that is the thing
 * that is actually unique and stable: a poll that arrives twice, or one that
 * overlaps a retry re-reporting an earlier attempt's channels, must not add the
 * same card again. Order is preserved, so channels appear in the order they were
 * written.
 *
 * Entries without a `post` are skipped rather than faked — an older worker that
 * recorded only ids has nothing for the grid to render, and a placeholder card
 * would be worse than the row simply arriving on the next full refresh.
 */
export function newTopicPosts<TPost>(
  progress: TopicJobProgress<TPost> | null,
  seenPostIds: ReadonlySet<string>
): Array<{ postId: string; post: TPost }> {
  if (!progress?.posts) return [];
  const fresh: Array<{ postId: string; post: TPost }> = [];
  for (const entry of progress.posts) {
    if (seenPostIds.has(entry.postId)) continue;
    if (entry.post === undefined || entry.post === null) continue;
    fresh.push({ postId: entry.postId, post: entry.post });
  }
  return fresh;
}

/**
 * The channels this topic has no version for, in the order they were asked for.
 *
 * Failures and never-attempted channels are named together because they mean the
 * same thing to the person looking at the card — this topic has no post for that
 * channel — which is exactly how the synchronous path already reports them.
 */
export function missingChannels(progress: TopicJobProgress | null): string[] {
  if (!progress) return [];
  return [...(progress.failures ?? []).map((f) => f.channel), ...(progress.notAttempted ?? [])];
}

/**
 * Whether a finished run is worth reporting as an outright failure.
 *
 * A job that COMPLETED having written nothing is not a queue failure — it ran
 * fine and every channel was refused, which is a generation outcome and carries
 * a code the UI can explain. This distinguishes it from a job that never got to
 * report, where all the caller has is `lastError`.
 */
export function hasNoPosts(progress: TopicJobProgress | null): boolean {
  return (progress?.posts?.length ?? 0) === 0;
}

/** Re-exported so a caller follows a topic job without importing two modules. */
export type { BulkJobPhase as TopicJobPhase };
