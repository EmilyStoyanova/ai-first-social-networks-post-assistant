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
import { prismaMetricsSyncStore, startOfDay, type MetricsSyncStore } from "./_metrics-sync-store";

/**
 * Reads engagement metrics for a company's published posts and stores them.
 *
 * Scope (requirement 5): only posts that actually reached Buffer are eligible —
 * `bufferUpdateId IS NOT NULL` plus a published status. A post that was never
 * sent has no Buffer counterpart to ask about.
 *
 * Bounded, but fair. Buffer refreshes metrics once daily, so a post is read at
 * most once per calendar day; within that, a run takes the STALEST posts first
 * (never-read ones ahead of everything else). Ordering by recency instead — as
 * this did originally — handed every run the same newest posts and left older
 * ones permanently unread once the backlog grew past one batch.
 *
 * Coverage across a day is therefore a property of repeated runs, not of one big
 * run: each run reads what is still pending, and `collectedAt` carries the cursor
 * from one run to the next. runAnalyticsCron drives that loop across companies.
 *
 * This is the ONLY path that refreshes metrics after setup — there is no manual
 * refresh — so a failed read must never destroy what a previous read stored.
 * Failures are logged and recorded on the row; the figures themselves are left
 * standing (see observationColumns in _metrics-sync-store.ts).
 */

export interface SyncPostMetricsOptions {
  companyId: string;
  /** Max posts this run may read. Each costs exactly one Buffer request. */
  limit?: number;
  /**
   * Re-read posts already read today.
   *
   * The cron leaves this false: Buffer refreshes metrics once daily, so a second
   * automatic pass would return identical data and spend quota for nothing.
   * Only the first sync after a key is saved sets it true — that key may well be
   * added after the day's runs, and without force every post would count as
   * "already read today" and nothing would import.
   */
  force?: boolean;
  /**
   * Cooperative deadline, checked between posts. A run that stops early is not a
   * failure: the posts it did not reach keep their old `collectedAt` and are
   * therefore first in line next time.
   */
  shouldStop?: () => boolean;
  /** Injected in tests. */
  client?: BufferAnalyticsClient;
  store?: MetricsSyncStore;
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
  /**
   * Eligible posts still awaiting today's read once this run finished. Zero means
   * the company is fully covered for the day; anything else is the backlog the
   * next run picks up, and the number an operator should watch.
   */
  remaining: number;
  /** True when `shouldStop` cut the run short rather than the batch running out. */
  stoppedEarly: boolean;
}

/**
 * Per-run batch when a caller does not say otherwise. Deliberately small: this is
 * the size used by the generation cron's opportunistic top-up, where analytics
 * shares a time budget with LLM work. The analytics cron passes its own, larger
 * limit — see run-analytics-cron.service.ts.
 */
const DEFAULT_LIMIT = 15;

function emptySummary(): SyncPostMetricsSummary {
  return {
    skipped: false,
    examined: 0,
    updated: 0,
    noData: 0,
    forbidden: 0,
    notFound: 0,
    failed: 0,
    remaining: 0,
    stoppedEarly: false,
  };
}

interface StopContext {
  summary: SyncPostMetricsSummary;
  store: MetricsSyncStore;
  companyId: string;
  today: Date;
}

/**
 * Ends the run early because the key itself cannot be used, logging why.
 *
 * These conditions persist until someone fixes the key, and nothing in the UI
 * reports them any more, so the log line is the only signal an operator gets.
 * No stored metrics are touched: the posts simply keep the figures they had, and
 * the backlog is still reported so the run reads as interrupted, not as done.
 */
async function stopWithReason(
  { summary, store, companyId, today }: StopContext,
  reason: NonNullable<SyncPostMetricsSummary["reason"]>
): Promise<SyncPostMetricsSummary> {
  console.error(`[analytics] Metrics sync stopped for company ${companyId}: ${reason}`);
  return { ...(await withRemaining(summary, store, companyId, today)), skipped: true, reason };
}

export async function syncPostMetrics(
  options: SyncPostMetricsOptions
): Promise<SyncPostMetricsSummary> {
  const { companyId, limit = DEFAULT_LIMIT } = options;
  const store = options.store ?? prismaMetricsSyncStore;
  const shouldStop = options.shouldStop ?? (() => false);
  const now = options.now ?? new Date();
  const today = startOfDay(now);
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

  const posts = await store.selectPosts({
    companyId,
    limit,
    before: options.force ? null : today,
  });

  for (const post of posts) {
    // Checked before the request, never after: a run that stops here has spent
    // nothing on this post, and leaves it stalest-first for the next run.
    if (shouldStop()) {
      summary.stoppedEarly = true;
      break;
    }

    summary.examined += 1;

    let result: Awaited<ReturnType<BufferAnalyticsClient["getPostMetrics"]>>;
    try {
      result = await client.getPostMetrics(post.bufferUpdateId);
    } catch (err) {
      // These three are properties of the KEY, not of this post. Continuing would
      // burn one request per remaining post to learn the same thing, so stop and
      // let the next run retry. Logged rather than thrown: with no manual refresh
      // left, the cron log is where an operator learns why a company went quiet.
      const stop: StopContext = { summary, store, companyId, today };
      if (err instanceof AnalyticsKeyInvalidError) return stopWithReason(stop, "INVALID_KEY");
      if (err instanceof AnalyticsScopeError) return stopWithReason(stop, "INSUFFICIENT_SCOPE");
      if (err instanceof AnalyticsRateLimitError) {
        // Buffer is the one saying stop. Backing off for the rest of the run is
        // what keeps the remaining daily budget intact for publishing.
        return stopWithReason(stop, "RATE_LIMITED");
      }

      const reason = err instanceof Error ? err.message : "Unknown error.";
      console.error(
        `[analytics] Metrics read failed for post ${post.id} (company ${companyId}): ${reason}`
      );
      summary.failed += 1;
      // Records the failure WITHOUT touching the stored figures — a transient
      // Buffer error must not blank a post's engagement numbers. It still stamps
      // collectedAt, so a post that fails repeatedly cannot monopolise the batch.
      await store.recordOutcome({
        postId: post.id,
        companyId,
        collectedAt: now,
        syncStatus: "error",
        syncError: reason.slice(0, 500),
      });
      continue;
    }

    switch (result.status) {
      case "ok": {
        summary.updated += 1;
        await store.recordOutcome({
          postId: post.id,
          companyId,
          collectedAt: now,
          syncStatus: "ok",
          syncError: null,
          // Buffer's channelService, never Post.channel — they disagree in real data.
          channelService: result.channelService,
          metricsUpdatedAt: result.metricsUpdatedAt ? new Date(result.metricsUpdatedAt) : null,
          metrics: normalizeMetrics(result.metrics),
          raw: result.metrics as unknown as Prisma.InputJsonValue,
        });
        break;
      }
      case "no_data": {
        summary.noData += 1;
        await store.recordOutcome({
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
        await store.recordOutcome({
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
        await store.recordOutcome({
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
    await store.stampKeyValid(companyId, now);
  }

  return withRemaining(summary, store, companyId, today);
}

/** Attaches the day's outstanding backlog — the signal that drives the next run. */
async function withRemaining(
  summary: SyncPostMetricsSummary,
  store: MetricsSyncStore,
  companyId: string,
  today: Date
): Promise<SyncPostMetricsSummary> {
  return { ...summary, remaining: await store.countRemaining(companyId, today) };
}
