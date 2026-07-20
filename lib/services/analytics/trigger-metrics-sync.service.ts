import { checkBufferAccess } from "@/lib/services/buffer/_access";
import { syncPostMetrics, type SyncPostMetricsSummary } from "./sync-post-metrics.service";

/**
 * Forced, read-only analytics sync — the single entry point shared by every
 * caller that wants metrics *now* rather than on the cron's schedule:
 *
 *   • the manual "sync now" endpoint (via triggerMetricsSync below);
 *   • the automatic first sync after a Personal API Key is saved
 *     (lib/services/analytics/manage-analytics-key.service.ts).
 *
 * The cron deliberately does NOT come through here: it uses syncPostMetrics
 * directly with force=false and a smaller batch, because Buffer refreshes
 * metrics once daily and a second automatic pass would spend quota re-reading
 * identical data.
 *
 * Nothing in this path can publish. It only reads from Buffer.
 */

export type TriggerMetricsSyncResult =
  | { success: true; data: SyncPostMetricsSummary }
  | { success: false; code: "NOT_FOUND" | "FORBIDDEN" };

/**
 * Larger than the cron's 15. A forced sync is a deliberate, infrequent act — a
 * button press or a one-time key setup — so it is worth covering a company's
 * whole backlog at once. Still bounded: Buffer's daily budget (250, shared with
 * publishing) must survive several of these.
 */
export const FORCED_SYNC_LIMIT = 50;

/**
 * Runs the forced sync for an already-authorized company.
 *
 * Takes a companyId rather than a slug because callers that reach it have
 * already resolved and authorized the company — re-checking would be a second
 * round-trip to prove something known.
 */
export async function runForcedMetricsSync(
  companyId: string,
  /** Injected in tests; production always uses the real sync. */
  sync: typeof syncPostMetrics = syncPostMetrics
): Promise<SyncPostMetricsSummary> {
  return sync({
    companyId,
    limit: FORCED_SYNC_LIMIT,
    // force=true is the whole point: a person asked for this, so the
    // "already synced today" guard must not turn it into a no-op.
    force: true,
  });
}

/** Owner-scoped wrapper for the manual "sync now" endpoint. */
export async function triggerMetricsSync(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<TriggerMetricsSyncResult> {
  const access = await checkBufferAccess(slug, userId, isGlobalAdmin);
  if (!access.ok) return { success: false, code: access.error };

  return { success: true, data: await runForcedMetricsSync(access.companyId) };
}
