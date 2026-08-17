/**
 * Article classification job handler — a THIN ADAPTER over the existing cron
 * service.
 *
 * The worker is an orchestrator only: this handler holds no classification logic
 * and no AI logic. It delegates to `runClassificationCron`, maps its summary to
 * compact job-result diagnostics, and re-throws on a top-level failure so the
 * queue applies its retry / terminal-failure policy.
 *
 * `runClassificationCron` already isolates per-company failures, so a completed
 * run with `failedCompanies > 0` is NOT retried — only a genuine run-level
 * failure throws.
 *
 * Self-continuation is identical to translation's, and carries NO dedupe key for
 * the same reason: this enqueue runs inside the handler while the spawning job is
 * still `active` holding the shared key, so reusing it would dedupe the
 * continuation against its own parent and it would never enqueue. The
 * continuation is inherently sequential, and the translation tick remains the
 * backstop.
 */

import type { JobHandler } from "./handler-registry";
import {
  runClassificationCron,
  type ClassificationCronSummary,
} from "@/lib/services/cron/run-classification-cron.service";
import { enqueueJob, type EnqueueJobResult } from "@/lib/services/queue/enqueue-job.service";
import { RSS_CLASSIFICATION_JOB_TYPE } from "@/lib/queue/job-types";

export { RSS_CLASSIFICATION_JOB_TYPE };

export type EnqueueClassificationContinuation = () => Promise<EnqueueJobResult>;

export function defaultEnqueueClassificationContinuation(
  enqueue: typeof enqueueJob = enqueueJob
): Promise<EnqueueJobResult> {
  return enqueue({ type: RSS_CLASSIFICATION_JOB_TYPE });
}

/**
 * Compact, operator-facing diagnostics persisted as the job's `result`. A `type`
 * (not `interface`) so it carries an index signature and satisfies `JobResult`.
 */
export type RssClassificationDiagnostics = {
  runId: string;
  examinedCompanies: number;
  processedCompanies: number;
  failedCompanies: number;
  classified: number;
  failed: number;
  skipped: number;
  remaining: number;
  durationMs: number;
  timedOut: boolean;
};

export function toDiagnostics(summary: ClassificationCronSummary): RssClassificationDiagnostics {
  return {
    runId: summary.runId,
    examinedCompanies: summary.companiesExamined,
    processedCompanies: summary.companiesProcessed,
    failedCompanies: summary.failures.length,
    classified: summary.classified,
    failed: summary.failed,
    skipped: summary.skipped,
    remaining: summary.remaining,
    durationMs: summary.durationMs,
    timedOut: summary.timedOut,
  };
}

export function createRssClassificationHandler(
  runClassification: () => Promise<ClassificationCronSummary> = () => runClassificationCron(),
  enqueueContinuation: EnqueueClassificationContinuation = defaultEnqueueClassificationContinuation
): JobHandler {
  return async ({ job, logger }) => {
    logger.info("rss classification starting", { jobId: job.id, attempt: job.attempts });

    const summary = await runClassification();
    const diagnostics = toDiagnostics(summary);

    if (summary.status === "failed") {
      logger.error("rss classification run failed", { jobId: job.id, error: summary.error });
      throw new Error(summary.error ?? "RSS classification run failed");
    }

    logger.info("rss classification completed", { jobId: job.id, ...diagnostics });

    if (summary.remaining > 0) {
      try {
        const enqueue = await enqueueContinuation();
        logger.info("rss classification continuation enqueued", {
          jobId: job.id,
          remaining: summary.remaining,
          enqueued: enqueue.enqueued,
          deduplicated: enqueue.deduplicated,
          continuationJobId: enqueue.jobId,
        });
      } catch (err) {
        logger.error("rss classification continuation enqueue failed (ignored)", {
          jobId: job.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return diagnostics;
  };
}

/** The production handler, wired to the real service + continuation enqueue. */
export const rssClassificationHandler: JobHandler = createRssClassificationHandler();
