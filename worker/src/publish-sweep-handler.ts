/**
 * Publishing sweep job handler — a THIN ADAPTER over the existing cron service.
 *
 * The worker is an orchestrator only: this handler contains no Buffer, scheduling or
 * due-date logic. It delegates to `runPublishCron`, maps its summary to compact job
 * diagnostics, and re-throws on a top-level failure so the queue applies its retry /
 * terminal-failure policy.
 *
 * Retry policy is the one thing worth being deliberate about here, because a retry
 * means talking to Buffer again. A completed sweep is NEVER retried, even when it
 * reports failed companies or failed posts:
 *
 *   • a per-company failure is already isolated, and re-running would re-send every
 *     post the sweep DID deliver — the exact duplicate-delivery this design exists
 *     to prevent, arriving through the retry path instead of a concurrent one;
 *   • a per-post failure has its own retry step with its own backoff budget
 *     (`retryFailedPosts`), which is where re-attempting a single post belongs;
 *   • and a post still waiting is not a failure at all — the next tick is 30 minutes
 *     away, and the sweep re-derives what is due from `scheduledFor` every run.
 *
 * Only a top-level throw (the run could not record itself, the database was
 * unreachable) is retried, and that is a sweep which published nothing.
 */

import type { JobHandler } from "./handler-registry";
import {
  runPublishCron,
  type PublishCronSummary,
} from "@/lib/services/cron/run-publish-cron.service";
import { PUBLISH_SWEEP_JOB_TYPE } from "@/lib/queue/job-types";

export { PUBLISH_SWEEP_JOB_TYPE };

/**
 * Compact, operator-facing diagnostics persisted as the job's `result`. A `type`
 * (not `interface`) so it carries an index signature and satisfies `JobResult`.
 *
 * `remainingCompanies` and `pastDuePosts` are the two to watch. The first says the
 * sweep is undersized for the number of companies publishing; the second says posts
 * are missing their slots by more than the grace, which at a 30-minute cadence means
 * something upstream — approval, the worker, the scheduler — is not running.
 */
export type PublishSweepDiagnostics = {
  runId: string;
  examinedCompanies: number;
  processedCompanies: number;
  failedCompanies: number;
  publishedPosts: number;
  failedPosts: number;
  skippedPosts: number;
  pastDuePosts: number;
  remainingCompanies: number;
  durationMs: number;
  timedOut: boolean;
};

export function toDiagnostics(summary: PublishCronSummary): PublishSweepDiagnostics {
  return {
    runId: summary.runId,
    examinedCompanies: summary.examined,
    processedCompanies: summary.processed,
    failedCompanies: summary.failed,
    publishedPosts: summary.published,
    failedPosts: summary.failedPosts,
    skippedPosts: summary.skipped,
    pastDuePosts: summary.pastDue,
    remainingCompanies: summary.remaining,
    durationMs: summary.durationMs,
    timedOut: summary.timedOut,
  };
}

/**
 * Factory so tests can inject the runner; production wires the real `runPublishCron`
 * service with its own production defaults.
 */
export function createPublishSweepHandler(
  runSweep: () => Promise<PublishCronSummary> = () => runPublishCron()
): JobHandler {
  return async ({ job, logger }) => {
    logger.info("publish sweep starting", { jobId: job.id, attempt: job.attempts });

    const summary = await runSweep();
    const diagnostics = toDiagnostics(summary);

    if (summary.status === "failed") {
      logger.error("publish sweep failed", { jobId: job.id, error: summary.error });
      // Throw so the orchestrator requeues (retry) or fails terminally per policy.
      throw new Error(summary.error ?? "Publish sweep failed");
    }

    logger.info("publish sweep completed", { jobId: job.id, ...diagnostics });
    return diagnostics;
  };
}

/** The production handler, wired to the real publishing sweep. */
export const publishSweepHandler: JobHandler = createPublishSweepHandler();
