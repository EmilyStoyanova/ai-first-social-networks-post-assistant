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
 *
 * ── 2026-09 production livelock fix ──────────────────────────────────────
 * This used to self-enqueue whenever `summary.remaining > 0`, full stop. A
 * bug in the per-item processor (fixed — see
 * `extract-competitor-intelligence.service.ts`'s module comment) made
 * `remaining` report the same 10 rows forever, and this unconditional check
 * hot-looped the worker across multiple restarts. The guard below is the
 * independent, root-cause-agnostic half of that fix: it only self-enqueues
 * when the drain reports BOTH genuinely-ready work (`remainingReady > 0`)
 * AND actual forward progress this run (`progressed`) — see
 * `run-competitor-intelligence-extraction.service.ts`'s module comment for
 * what each means. A batch that made zero progress, or whose only remaining
 * rows are deferred behind another run's active lease, does NOT
 * self-enqueue; the normal cron/job-wake cadence picks the drain back up
 * once there is something it can actually do.
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

    // No-progress guard (2026-09 livelock fix) — see this file's module
    // comment. Both conditions matter independently: `remainingReady`
    // excludes rows this run could never have acted on anyway (deferred
    // behind another run's active lease); `progressed` excludes the case
    // where ready rows exist but every one of them was a no-op skip
    // (contended claim, no provider configured, etc.) — enqueuing again
    // immediately would just reproduce the exact same result.
    if (summary.remainingReady > 0 && summary.progressed) {
      try {
        const enqueue = await enqueueContinuation();
        logger.info("competitor intelligence extraction continuation enqueued", {
          jobId: job.id,
          remainingReady: summary.remainingReady,
          remainingDeferred: summary.remainingDeferred,
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
    } else if (summary.remainingReady > 0 || summary.remainingDeferred > 0) {
      logger.info("competitor intelligence extraction continuation withheld — no progress", {
        jobId: job.id,
        remainingReady: summary.remainingReady,
        remainingDeferred: summary.remainingDeferred,
        progressed: summary.progressed,
        skippedByReason: summary.skippedByReason,
      });
    }

    return summary;
  };
}

export const competitorIntelligenceExtractionHandler: JobHandler =
  createCompetitorIntelligenceExtractionHandler();
