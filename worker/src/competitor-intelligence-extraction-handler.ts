/**
 * Competitive Intelligence extraction job handler — a THIN ADAPTER over
 * `runCompetitorIntelligenceExtraction` (Part 3B §13). The worker is an
 * orchestrator only: no extraction logic lives here.
 *
 * Self-continuation mirrors `rss-classification-handler.ts` exactly, for the
 * identical reason: this enqueue runs while the spawning job is still
 * `active` holding the dedupe key, so it carries NO dedupe key of its own —
 * reusing it would dedupe the continuation against its own parent and it
 * would never enqueue.
 */

import type { JobHandler } from "./handler-registry";
import {
  runCompetitorIntelligenceExtraction,
  type CompetitorIntelligenceExtractionSummary,
} from "@/lib/services/competitive-analysis/run-competitor-intelligence-extraction.service";
import { enqueueJob, type EnqueueJobResult } from "@/lib/services/queue/enqueue-job.service";
import { COMPETITOR_INTELLIGENCE_EXTRACTION_JOB_TYPE } from "@/lib/queue/job-types";

export { COMPETITOR_INTELLIGENCE_EXTRACTION_JOB_TYPE };

export type EnqueueExtractionContinuation = () => Promise<EnqueueJobResult>;

export function defaultEnqueueExtractionContinuation(
  enqueue: typeof enqueueJob = enqueueJob
): Promise<EnqueueJobResult> {
  return enqueue({ type: COMPETITOR_INTELLIGENCE_EXTRACTION_JOB_TYPE });
}

export type CompetitorIntelligenceExtractionDiagnostics = CompetitorIntelligenceExtractionSummary;

export function createCompetitorIntelligenceExtractionHandler(
  runExtraction: () => Promise<CompetitorIntelligenceExtractionSummary> = runCompetitorIntelligenceExtraction,
  enqueueContinuation: EnqueueExtractionContinuation = defaultEnqueueExtractionContinuation
): JobHandler {
  return async ({ job, logger }) => {
    logger.info("competitor intelligence extraction starting", {
      jobId: job.id,
      attempt: job.attempts,
    });

    const summary = await runExtraction();

    logger.info("competitor intelligence extraction completed", { jobId: job.id, ...summary });

    if (summary.remaining > 0) {
      try {
        const enqueue = await enqueueContinuation();
        logger.info("competitor intelligence extraction continuation enqueued", {
          jobId: job.id,
          remaining: summary.remaining,
          enqueued: enqueue.enqueued,
          deduplicated: enqueue.deduplicated,
          continuationJobId: enqueue.jobId,
        });
      } catch (err) {
        logger.error("competitor intelligence extraction continuation enqueue failed (ignored)", {
          jobId: job.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return summary;
  };
}

export const competitorIntelligenceExtractionHandler: JobHandler =
  createCompetitorIntelligenceExtractionHandler();
