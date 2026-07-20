import { prisma } from "@/lib/db/client";
import { Prisma } from "@prisma/client";
import { getBufferAnalyticsClient } from "@/lib/buffer/buffer-analytics-provider";
import type { BufferAnalyticsClient } from "@/lib/buffer/buffer-analytics-client";
import {
  AnalyticsNoKeyError,
  AnalyticsKeyInvalidError,
  AnalyticsRateLimitError,
  AnalyticsScopeError,
} from "@/lib/buffer/buffer-analytics-errors";
import { normalizeMetrics } from "@/lib/buffer/metric-normalizer";

/**
 * Reads engagement metrics for a company's published posts and stores them.
 *
 * Scope (requirement 5): only posts that actually reached Buffer are eligible —
 * `bufferUpdateId IS NOT NULL` plus a published status. A post that was never
 * sent has no Buffer counterpart to ask about.
 *
 * Bounded by design. Buffer refreshes metrics once daily, so re-reading more
 * often returns byte-identical data while consuming the 250-requests/day budget
 * that publishing also draws on. The cron therefore syncs a small batch per run,
 * oldest-collected first, and skips posts already synced today.
 */

export interface SyncPostMetricsOptions {
  companyId: string;
  /** Max posts per run. Each costs exactly one Buffer request. */
  limit?: number;
  /** Injected in tests. */
  client?: BufferAnalyticsClient;
  now?: Date;
}

export interface SyncPostMetricsSummary {
  /** True when no key is configured — the expected state, not a failure. */
  skipped: boolean;
  reason?: "NO_KEY" | "INVALID_KEY" | "INSUFFICIENT_SCOPE" | "RATE_LIMITED";
  examined: number;
  updated: number;
  noData: number;
  forbidden: number;
  notFound: number;
  failed: number;
}

const DEFAULT_LIMIT = 15;

/** Posts in these statuses have been sent to Buffer and can carry metrics. */
const SYNCABLE_STATUSES = ["sent_to_buffer", "published"] as const;

function emptySummary(): SyncPostMetricsSummary {
  return {
    skipped: false,
    examined: 0,
    updated: 0,
    noData: 0,
    forbidden: 0,
    notFound: 0,
    failed: 0,
  };
}

/** Midnight-anchored so "already synced today" is stable within a calendar day. */
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export async function syncPostMetrics(
  options: SyncPostMetricsOptions
): Promise<SyncPostMetricsSummary> {
  const { companyId, limit = DEFAULT_LIMIT } = options;
  const now = options.now ?? new Date();
  const summary = emptySummary();

  // ── Resolve the analytics client ───────────────────────────────────────────
  // A missing key is the ordinary "analytics not enabled" state and must not
  // surface as an error in the cron summary.
  let client: BufferAnalyticsClient;
  try {
    client = options.client ?? (await getBufferAnalyticsClient(companyId));
  } catch (err) {
    if (err instanceof AnalyticsNoKeyError) return { ...summary, skipped: true, reason: "NO_KEY" };
    throw err;
  }

  const today = startOfDay(now);

  // Eligible: published through Buffer, and either never synced or last synced
  // before today. Oldest first so a backlog drains fairly across runs rather
  // than the same few posts being refreshed repeatedly.
  const posts = await prisma.post.findMany({
    where: {
      companyId,
      bufferUpdateId: { not: null },
      status: { in: [...SYNCABLE_STATUSES] },
      OR: [{ metrics: { is: null } }, { metrics: { collectedAt: { lt: today } } }],
    },
    select: { id: true, bufferUpdateId: true },
    orderBy: [{ publishedAt: "desc" }],
    take: limit,
  });

  for (const post of posts) {
    summary.examined += 1;
    const bufferPostId = post.bufferUpdateId!;

    let result: Awaited<ReturnType<BufferAnalyticsClient["getPostMetrics"]>>;
    try {
      result = await client.getPostMetrics(bufferPostId);
    } catch (err) {
      // These three are properties of the KEY, not of this post. Continuing would
      // burn one request per remaining post to learn the same thing, so stop and
      // let the next run retry.
      if (err instanceof AnalyticsKeyInvalidError) {
        return { ...summary, skipped: true, reason: "INVALID_KEY" };
      }
      if (err instanceof AnalyticsScopeError) {
        return { ...summary, skipped: true, reason: "INSUFFICIENT_SCOPE" };
      }
      if (err instanceof AnalyticsRateLimitError) {
        return { ...summary, skipped: true, reason: "RATE_LIMITED" };
      }

      summary.failed += 1;
      await recordSyncOutcome({
        postId: post.id,
        companyId,
        collectedAt: now,
        syncStatus: "error",
        syncError: err instanceof Error ? err.message.slice(0, 500) : "Unknown error.",
      });
      continue;
    }

    switch (result.status) {
      case "ok": {
        const normalized = normalizeMetrics(result.metrics);
        summary.updated += 1;
        await recordSyncOutcome({
          postId: post.id,
          companyId,
          collectedAt: now,
          syncStatus: "ok",
          syncError: null,
          // Buffer's channelService, never Post.channel — they disagree in real data.
          channelService: result.channelService,
          metricsUpdatedAt: result.metricsUpdatedAt ? new Date(result.metricsUpdatedAt) : null,
          metrics: normalized,
          raw: result.metrics as unknown as Prisma.InputJsonValue,
        });
        break;
      }
      case "no_data": {
        summary.noData += 1;
        await recordSyncOutcome({
          postId: post.id,
          companyId,
          collectedAt: now,
          syncStatus: "no_data",
          syncError: null,
          channelService: result.channelService,
          metricsUpdatedAt: result.metricsUpdatedAt ? new Date(result.metricsUpdatedAt) : null,
        });
        break;
      }
      case "forbidden": {
        // The key's Buffer organization does not own this post. Recorded so the
        // UI can say so precisely instead of showing a generic failure.
        summary.forbidden += 1;
        await recordSyncOutcome({
          postId: post.id,
          companyId,
          collectedAt: now,
          syncStatus: "forbidden",
          syncError: null,
        });
        break;
      }
      case "not_found": {
        summary.notFound += 1;
        await recordSyncOutcome({
          postId: post.id,
          companyId,
          collectedAt: now,
          syncStatus: "not_found",
          syncError: null,
        });
        break;
      }
    }
  }

  // Stamp the key as working if anything at all came back. FORBIDDEN counts:
  // the key authenticated fine, it simply does not cover that post.
  if (summary.updated + summary.noData + summary.forbidden > 0) {
    await prisma.bufferConnection.updateMany({
      where: { companyId },
      data: { analyticsKeyLastValidAt: now },
    });
  }

  return summary;
}

// ─── Persistence ──────────────────────────────────────────────────────────────

interface RecordOutcomeInput {
  postId: string;
  companyId: string;
  collectedAt: Date;
  syncStatus: "ok" | "no_data" | "forbidden" | "not_found" | "error";
  syncError: string | null;
  channelService?: string | null;
  metricsUpdatedAt?: Date | null;
  metrics?: ReturnType<typeof normalizeMetrics>;
  raw?: Prisma.InputJsonValue;
}

/**
 * Writes the current-state row and, when there are real metrics, appends a
 * history snapshot.
 *
 * Snapshots exist because Buffer returns cumulative lifetime totals with no
 * time-series surface — day-over-day movement can only come from our own
 * sampling, and cannot be reconstructed after the fact. Only `ok` results are
 * snapshotted: recording a forbidden or errored read as history would put
 * gaps into the series that look like engagement dropping to nothing.
 */
async function recordSyncOutcome(input: RecordOutcomeInput): Promise<void> {
  const m = input.metrics;

  const metricColumns = {
    reactions: m?.reactions ?? null,
    comments: m?.comments ?? null,
    shares: m?.shares ?? null,
    impressions: m?.impressions ?? null,
    clicks: m?.clicks ?? null,
    reach: m?.reach ?? null,
    views: m?.views ?? null,
    saves: m?.saves ?? null,
    follows: m?.follows ?? null,
    engagementRate: m?.engagementRate ?? null,
    engagementRateDenominator: m?.engagementRateDenominator ?? null,
  };

  await prisma.postMetric.upsert({
    where: { postId: input.postId },
    create: {
      postId: input.postId,
      companyId: input.companyId,
      channelService: input.channelService ?? null,
      metricsUpdatedAt: input.metricsUpdatedAt ?? null,
      collectedAt: input.collectedAt,
      syncStatus: input.syncStatus,
      syncError: input.syncError,
      raw: input.raw ?? Prisma.JsonNull,
      ...metricColumns,
    },
    update: {
      channelService: input.channelService ?? null,
      metricsUpdatedAt: input.metricsUpdatedAt ?? null,
      collectedAt: input.collectedAt,
      syncStatus: input.syncStatus,
      syncError: input.syncError,
      raw: input.raw ?? Prisma.JsonNull,
      ...metricColumns,
    },
  });

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
      ...metricColumns,
    },
    update: { channelService: input.channelService ?? null, ...metricColumns },
  });
}
