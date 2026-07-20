import { checkBufferAccess } from "@/lib/services/buffer/_access";
import { syncPostMetrics, type SyncPostMetricsSummary } from "./sync-post-metrics.service";

/**
 * Owner-triggered "sync now" for a company's post metrics.
 *
 * Exists because the cron alone is not enough to get started: it processes one
 * company per run on a daily schedule, so a freshly configured key could wait
 * several days before its first data appears. Triggering the full cron endpoint
 * instead is not an option — that would also ingest feeds, generate posts, and
 * publish scheduled ones.
 *
 * This is analytics-only and read-only against Buffer. It cannot publish
 * anything.
 */

export type TriggerMetricsSyncResult =
  | { success: true; data: SyncPostMetricsSummary }
  | { success: false; code: "NOT_FOUND" | "FORBIDDEN" };

/**
 * Larger than the cron's 15. A manual run is a deliberate, infrequent act and
 * the operator is watching it, so it is worth covering a company's whole backlog
 * in one press rather than making them click repeatedly. Still bounded: Buffer's
 * daily budget (250, shared with publishing) must survive several presses.
 */
const MANUAL_LIMIT = 50;

export async function triggerMetricsSync(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<TriggerMetricsSyncResult> {
  // Owner-only, matching every other Buffer credential operation.
  const access = await checkBufferAccess(slug, userId, isGlobalAdmin);
  if (!access.ok) return { success: false, code: access.error };

  const summary = await syncPostMetrics({
    companyId: access.companyId,
    limit: MANUAL_LIMIT,
    // A person pressing a button means "go and look now", so bypass the
    // once-daily guard the cron relies on.
    force: true,
  });

  return { success: true, data: summary };
}
