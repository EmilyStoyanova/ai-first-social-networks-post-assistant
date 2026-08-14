/**
 * Product-page extraction job handler — a THIN ADAPTER over the existing service.
 *
 * The worker is an orchestrator only: this handler holds no extraction logic and
 * no AI logic. It calls `runPendingExtractions`, maps the summary to compact job
 * diagnostics, and chains a continuation when the drain left work behind — the
 * same shape as the RSS translation handler, for the same reasons.
 *
 * Per-item failures are DATA (the service records them on the row and continues),
 * so a completed run with `failed > 0` is not retried. Only a genuine run-level
 * fault throws, and the queue applies its own retry policy to that.
 */

import type { JobHandler } from "./handler-registry";
import {
  runPendingExtractions,
  type PendingExtractionsSummary,
} from "@/lib/services/ai/run-pending-extractions.service";
import { enqueueJob, type EnqueueJobResult } from "@/lib/services/queue/enqueue-job.service";
import { PRODUCT_PAGE_EXTRACTION_JOB_TYPE } from "@/lib/queue/job-types";

export { PRODUCT_PAGE_EXTRACTION_JOB_TYPE };

/**
 * The continuation enqueue seam. Carries NO dedupe key, for the reason spelled
 * out in the translation handler: this runs while the spawning job is still
 * `active` and holding the shared key, so any fixed key would dedupe the
 * continuation against its own parent and it would never enqueue.
 */
export type EnqueueExtractionContinuation = () => Promise<EnqueueJobResult>;

export function defaultEnqueueExtractionContinuation(
  enqueue: typeof enqueueJob = enqueueJob
): Promise<EnqueueJobResult> {
  return enqueue({ type: PRODUCT_PAGE_EXTRACTION_JOB_TYPE, priority: 5 });
}

/** Compact, operator-facing diagnostics persisted as the job's `result`. */
export type ProductPageExtractionDiagnostics = {
  examined: number;
  extracted: number;
  notFound: number;
  failed: number;
  skipped: number;
  remaining: number;
  durationMs: number;
};

export function toDiagnostics(
  summary: PendingExtractionsSummary
): ProductPageExtractionDiagnostics {
  return {
    examined: summary.examined,
    extracted: summary.extracted,
    notFound: summary.notFound,
    failed: summary.failed,
    skipped: summary.skipped,
    remaining: summary.remaining,
    durationMs: summary.durationMs,
  };
}

export function createProductPageExtractionHandler(
  runExtractions: () => Promise<PendingExtractionsSummary> = () => runPendingExtractions(),
  enqueueContinuation: EnqueueExtractionContinuation = defaultEnqueueExtractionContinuation
): JobHandler {
  return async ({ job, logger }) => {
    logger.info("product-page extraction starting", { jobId: job.id, attempt: job.attempts });

    const summary = await runExtractions();
    const diagnostics = toDiagnostics(summary);

    logger.info("product-page extraction completed", { jobId: job.id, ...diagnostics });

    // Drain the rest across back-to-back runs rather than in one long job.
    // Best-effort: a failure here must never retry a successful run.
    if (summary.remaining > 0 && summary.examined > 0) {
      try {
        const enqueue = await enqueueContinuation();
        logger.info("product-page extraction continuation enqueued", {
          jobId: job.id,
          remaining: summary.remaining,
          enqueued: enqueue.enqueued,
          deduplicated: enqueue.deduplicated,
          continuationJobId: enqueue.jobId,
        });
      } catch (err) {
        logger.error("product-page extraction continuation enqueue failed (ignored)", {
          jobId: job.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return diagnostics;
  };
}

/** The production handler, wired to the real service + continuation enqueue. */
export const productPageExtractionHandler: JobHandler = createProductPageExtractionHandler();
