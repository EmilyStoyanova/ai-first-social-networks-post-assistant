import { prisma } from "@/lib/db/client";
import { Prisma } from "@prisma/client";

/**
 * Persistence seam for the metrics sync (v2-7, coverage rework).
 *
 * It exists for one reason: the batching strategy — which posts a run picks, in
 * what order, and how repeated runs eventually cover everything — is the part
 * most likely to break silently, and it cannot be tested against Prisma without a
 * live database. Behind this interface the strategy is exercised end to end with
 * an in-memory store (see sync-post-metrics.service.test.ts), while production
 * keeps the real, index-backed queries below.
 */

/** A post that reached Buffer and can therefore carry metrics. */
export interface SyncablePost {
  id: string;
  bufferUpdateId: string;
}

export interface SelectPostsInput {
  companyId: string;
  limit: number;
  /**
   * Start of today. Posts already read today are excluded, which is what makes a
   * day's work finite and lets several runs share it.
   *
   * `null` means forced mode (the one-off sync after a key is saved): read the
   * backlog regardless of when it was last collected.
   */
  before: Date | null;
}

export interface RecordOutcomeInput {
  postId: string;
  companyId: string;
  collectedAt: Date;
  syncStatus: MetricSyncStatus;
  syncError: string | null;
  channelService?: string | null;
  metricsUpdatedAt?: Date | null;
  metrics?: MetricFigures | null;
  raw?: Prisma.InputJsonValue;
}

export type MetricSyncStatus = "ok" | "no_data" | "forbidden" | "not_found" | "error";

/** The engagement figures themselves — the same shape in the row and in history. */
export interface MetricFigures {
  reactions: number | null;
  comments: number | null;
  shares: number | null;
  impressions: number | null;
  clicks: number | null;
  reach: number | null;
  views: number | null;
  saves: number | null;
  follows: number | null;
  engagementRate: number | null;
  engagementRateDenominator: string | null;
}

export interface MetricsSyncStore {
  /** This run's batch, in the order it should be read. */
  selectPosts(input: SelectPostsInput): Promise<SyncablePost[]>;
  /** Persists one post's outcome (and, for a successful read, a history snapshot). */
  recordOutcome(input: RecordOutcomeInput): Promise<void>;
  /** Stamps the key as known-good — the "Last checked" the settings card shows. */
  stampKeyValid(companyId: string, at: Date): Promise<void>;
  /** Eligible posts still awaiting today's read. Zero means the day is covered. */
  countRemaining(companyId: string, before: Date): Promise<number>;
  /** Posts already read today — the company's spend against Buffer's daily budget. */
  countReadToday(companyId: string, before: Date): Promise<number>;
}

/** Posts in these statuses have been sent to Buffer and can carry metrics. */
export const SYNCABLE_STATUSES = ["sent_to_buffer", "published"] as const;

/** Only posts that actually reached Buffer have a counterpart to ask about. */
const eligible = {
  bufferUpdateId: { not: null },
  status: { in: [...SYNCABLE_STATUSES] },
} satisfies Prisma.PostWhereInput;

/** Not yet read today: never read at all, or last read before midnight. */
function pending(before: Date): Prisma.PostWhereInput {
  return { OR: [{ metrics: { is: null } }, { metrics: { collectedAt: { lt: before } } }] };
}

/**
 * Two-phase, stalest-first selection — the fairness rule.
 *
 * Phase 1 takes posts that have never been read at all. They are the only ones
 * showing an owner nothing, and they have no collectedAt to be ordered by, so
 * they come first as a group. The group shrinks monotonically: every post read
 * leaves it for good.
 *
 * Phase 2 fills the rest from the least-recently-read posts, straight off the
 * `[companyId, collectedAt]` index. This is what stops the old behaviour, where
 * ordering by publishedAt handed every run the same newest posts and left an
 * older one permanently unread.
 *
 * collectedAt IS the cursor. Every read advances it — successful or not, since
 * the attempt fields are always written — so the next run resumes at whatever is
 * now stalest without any run-to-run state to keep, and without a run that died
 * halfway stranding the posts it never reached.
 */
async function selectPosts({
  companyId,
  limit,
  before,
}: SelectPostsInput): Promise<SyncablePost[]> {
  if (limit <= 0) return [];

  // Forced mode: the whole backlog is fair game, newest first — a person just
  // added a key and is looking at the most recent posts.
  if (before === null) {
    const rows = await prisma.post.findMany({
      where: { companyId, ...eligible },
      select: { id: true, bufferUpdateId: true },
      orderBy: [{ publishedAt: "desc" }],
      take: limit,
    });
    return rows.map(toSyncablePost);
  }

  const never = await prisma.post.findMany({
    where: { companyId, ...eligible, metrics: { is: null } },
    select: { id: true, bufferUpdateId: true },
    orderBy: [{ publishedAt: "desc" }],
    take: limit,
  });
  if (never.length >= limit) return never.map(toSyncablePost);

  const stale = await prisma.postMetric.findMany({
    where: { companyId, collectedAt: { lt: before }, post: eligible },
    select: { post: { select: { id: true, bufferUpdateId: true } } },
    orderBy: [{ collectedAt: "asc" }],
    take: limit - never.length,
  });

  return [...never.map(toSyncablePost), ...stale.map((row) => toSyncablePost(row.post))];
}

function toSyncablePost(row: { id: string; bufferUpdateId: string | null }): SyncablePost {
  // The eligibility filter guarantees a non-null id; the cast keeps the callers
  // free of a check the query already made.
  return { id: row.id, bufferUpdateId: row.bufferUpdateId! };
}

/**
 * Writes the current-state row and, when there are real metrics, appends a
 * history snapshot.
 *
 * The attempt fields (collectedAt, syncStatus, syncError) are always written —
 * that is how the next run knows this post was tried today and how an operator
 * sees what went wrong. The figures are written only by observationColumns, so a
 * failed read updates the status and leaves the numbers alone.
 *
 * Snapshots exist because Buffer returns cumulative lifetime totals with no
 * time-series surface — day-over-day movement can only come from our own
 * sampling, and cannot be reconstructed after the fact. Only `ok` results are
 * snapshotted: recording a forbidden or errored read as history would put gaps
 * into the series that look like engagement dropping to nothing.
 */
async function recordOutcome(input: RecordOutcomeInput): Promise<void> {
  const attempt = {
    collectedAt: input.collectedAt,
    syncStatus: input.syncStatus,
    syncError: input.syncError,
  };
  const observed = observationColumns(input);

  await prisma.postMetric.upsert({
    where: { postId: input.postId },
    // A first-time row has nothing to preserve, so the omitted columns simply
    // default to null.
    create: { postId: input.postId, companyId: input.companyId, ...attempt, ...observed },
    update: { ...attempt, ...observed },
  });

  const m = input.metrics;
  if (input.syncStatus !== "ok" || !m) return;

  // One snapshot per post per day: the unique index makes a same-day re-run
  // update in place rather than inflating the series with duplicates.
  const snapshotAt = startOfDay(input.collectedAt);
  await prisma.postMetricSnapshot.upsert({
    where: { postId_snapshotAt: { postId: input.postId, snapshotAt } },
    create: {
      postId: input.postId,
      companyId: input.companyId,
      channelService: input.channelService ?? null,
      snapshotAt,
      ...metricFigures(m),
    },
    update: { channelService: input.channelService ?? null, ...metricFigures(m) },
  });
}

/** Midnight-anchored so "already read today" is stable within a calendar day. */
export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** The observation columns — everything that describes what Buffer reported. */
interface ObservationColumns extends MetricFigures {
  channelService: string | null;
  metricsUpdatedAt: Date | null;
  raw: Prisma.PostMetricUncheckedCreateInput["raw"];
}

export function metricFigures(m: MetricFigures): MetricFigures {
  return {
    reactions: m.reactions ?? null,
    comments: m.comments ?? null,
    shares: m.shares ?? null,
    impressions: m.impressions ?? null,
    clicks: m.clicks ?? null,
    reach: m.reach ?? null,
    views: m.views ?? null,
    saves: m.saves ?? null,
    follows: m.follows ?? null,
    engagementRate: m.engagementRate ?? null,
    engagementRateDenominator: m.engagementRateDenominator ?? null,
  };
}

/**
 * The columns a sync outcome is allowed to write — the rule that keeps a failed
 * refresh from erasing good data.
 *
 * Only a successful read carries figures, so only a successful read writes them.
 * Every other outcome returns nothing to write, which on an existing row leaves
 * the last known figures exactly where they are; the attempt is still recorded
 * through syncStatus / syncError / collectedAt, which are written separately.
 *
 * This matters more than it looks: with no manual refresh, a post whose numbers
 * were blanked by one bad night would have no way back short of the next
 * successful run, and would meanwhile show an owner "no data" for a post that has
 * plenty.
 *
 * Exported for tests — the behaviour is a data-loss guard, so it is worth pinning
 * down directly rather than through a database.
 */
export function observationColumns(input: {
  syncStatus: MetricSyncStatus;
  channelService?: string | null;
  metricsUpdatedAt?: Date | null;
  metrics?: MetricFigures | null;
  raw?: Prisma.InputJsonValue;
}): Partial<ObservationColumns> {
  const m = input.metrics;
  if (input.syncStatus !== "ok" || !m) return {};

  return {
    channelService: input.channelService ?? null,
    metricsUpdatedAt: input.metricsUpdatedAt ?? null,
    ...metricFigures(m),
    raw: input.raw ?? Prisma.JsonNull,
  };
}

/** The production store — real Prisma, real indexes. */
export const prismaMetricsSyncStore: MetricsSyncStore = {
  selectPosts,
  recordOutcome,

  async stampKeyValid(companyId, at) {
    await prisma.bufferConnection.updateMany({
      where: { companyId },
      data: { analyticsKeyLastValidAt: at },
    });
  },

  async countRemaining(companyId, before) {
    return prisma.post.count({ where: { companyId, ...eligible, ...pending(before) } });
  },

  async countReadToday(companyId, before) {
    return prisma.postMetric.count({
      where: { companyId, collectedAt: { gte: before }, post: eligible },
    });
  },
};
