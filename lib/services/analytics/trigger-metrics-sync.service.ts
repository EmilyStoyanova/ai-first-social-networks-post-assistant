import { syncPostMetrics, type SyncPostMetricsSummary } from "./sync-post-metrics.service";

/**
 * Forced, read-only analytics sync — the one path that reads metrics outside the
 * cron's schedule.
 *
 * It has a single caller: the automatic first sync that runs when a Personal API
 * Key is saved (lib/services/analytics/manage-analytics-key.service.ts). There is
 * no manual "refresh" — after setup, metrics are re-read by the daily cron only.
 *
 * The cron deliberately does NOT come through here: it uses syncPostMetrics
 * directly with force=false and a smaller batch, because Buffer refreshes
 * metrics once daily and a second automatic pass would spend quota re-reading
 * identical data.
 *
 * Nothing in this path can publish. It only reads from Buffer.
 */

/**
 * Larger than the cron's 15. Setting up a key is a one-time act with a person
 * waiting on the result, so it is worth covering a company's whole backlog at
 * once. Still bounded: Buffer's daily budget (250, shared with publishing) must
 * survive it.
 */
export const FORCED_SYNC_LIMIT = 50;

/**
 * Runs the forced sync for an already-authorized company.
 *
 * Takes a companyId rather than a slug because the caller has already resolved
 * and authorized the company — re-checking would be a second round-trip to prove
 * something known.
 */
export async function runForcedMetricsSync(
  companyId: string,
  /** Injected in tests; production always uses the real sync. */
  sync: typeof syncPostMetrics = syncPostMetrics
): Promise<SyncPostMetricsSummary> {
  return sync({
    companyId,
    limit: FORCED_SYNC_LIMIT,
    // force=true is the whole point: a key saved after today's cron run would
    // otherwise find every post "already synced today" and import nothing.
    force: true,
  });
}
