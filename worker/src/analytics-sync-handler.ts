/**
 * Buffer analytics job handler — a THIN ADAPTER over the existing cron service.
 *
 * The worker is an orchestrator only: this handler contains no Buffer, batching or
 * scheduling logic. It delegates to `runAnalyticsCron`, maps its summary to compact
 * job-result diagnostics, and re-throws on a top-level failure so the queue applies
 * its retry / terminal-failure policy.
 *
 * As with the other handlers, a completed run with `failedCompanies > 0` is NOT
 * retried — the cron already isolates per-company failures, and re-running would
 * spend Buffer's daily allowance re-reading everything that succeeded.
 */

import type { JobHandler } from "./handler-registry";
import {
  runAnalyticsCron,
  type AnalyticsCronSummary,
} from "@/lib/services/cron/run-analytics-cron.service";
import { ANALYTICS_SYNC_JOB_TYPE } from "@/lib/queue/job-types";

export { ANALYTICS_SYNC_JOB_TYPE };

/**
 * Compact, operator-facing diagnostics persisted as the job's `result`. A `type`
 * (not `interface`) so it carries an index signature and satisfies `JobResult`.
 *
 * `remainingPosts` is the one to watch: it is the backlog still awaiting today's
 * read, so a value that never reaches zero means the schedule or the daily budget
 * is too tight for the number of published posts.
 */
export type AnalyticsSyncDiagnostics = {
  runId: string;
  examinedCompanies: number;
  processedCompanies: number;
  failedCompanies: number;
  budgetExhaustedCompanies: number;
  postsRead: number;
  postsUpdated: number;
  remainingPosts: number;
  durationMs: number;
  timedOut: boolean;
};

export function toDiagnostics(summary: AnalyticsCronSummary): AnalyticsSyncDiagnostics {
  return {
    runId: summary.runId,
    examinedCompanies: summary.examined,
    processedCompanies: summary.processed,
    failedCompanies: summary.failed,
    budgetExhaustedCompanies: summary.budgetExhausted,
    postsRead: summary.postsRead,
    postsUpdated: summary.postsUpdated,
    remainingPosts: summary.remaining,
    durationMs: summary.durationMs,
    timedOut: summary.timedOut,
  };
}

/**
 * Factory so tests can inject the runner; production wires the real
 * `runAnalyticsCron` service with its own production defaults.
 */
export function createAnalyticsSyncHandler(
  runAnalytics: () => Promise<AnalyticsCronSummary> = () => runAnalyticsCron()
): JobHandler {
  return async ({ job, logger }) => {
    logger.info("analytics sync starting", { jobId: job.id, attempt: job.attempts });

    const summary = await runAnalytics();
    const diagnostics = toDiagnostics(summary);

    if (summary.status === "failed") {
      logger.error("analytics sync run failed", { jobId: job.id, error: summary.error });
      // Throw so the orchestrator requeues (retry) or fails terminally per policy.
      throw new Error(summary.error ?? "Analytics sync run failed");
    }

    logger.info("analytics sync completed", { jobId: job.id, ...diagnostics });
    return diagnostics;
  };
}

/** The production handler, wired to the real analytics service. */
export const analyticsSyncHandler: JobHandler = createAnalyticsSyncHandler();
