/**
 * RSS ingestion job handler — a THIN ADAPTER over the existing cron service.
 *
 * The worker is an orchestrator only: this handler contains no ingestion logic.
 * It delegates to `runIngestionCron` (the same service the cron route used to call
 * inline), maps its summary to compact job-result diagnostics, and re-throws on a
 * top-level failure so the queue applies its retry / terminal-failure policy.
 *
 * Note: `runIngestionCron` already isolates per-source failures (a bad feed does
 * not fail the run), so a completed run with `failedSources > 0` is NOT retried —
 * only a genuine run-level failure (status "failed") throws.
 *
 * Phase 6.0 (event-driven translation): after a COMPLETED run that created new
 * feed items, this handler enqueues a single RSS translation job so newly imported
 * articles begin translating immediately instead of waiting for the scheduled
 * translation cron. This is pure orchestration — it reuses the existing translation
 * job type and the SHARED dedupe key, so it can never create a second concurrent
 * translation run and it duplicates no translation logic. The enqueue is a
 * best-effort follow-up: a failure is logged and swallowed (a successful import
 * must not be retried), and the scheduled translation cron remains the backstop.
 */

import type { JobHandler } from "./handler-registry";
import {
  runIngestionCron,
  type IngestionCronSummary,
} from "@/lib/services/cron/run-ingestion-cron.service";
import {
  enqueueJob,
  type EnqueueJobResult,
} from "@/lib/services/queue/enqueue-job.service";
import {
  RSS_INGESTION_JOB_TYPE,
  RSS_TRANSLATION_JOB_TYPE,
  RSS_TRANSLATION_DEDUPE_KEY,
} from "@/lib/queue/job-types";

export { RSS_INGESTION_JOB_TYPE };

/**
 * The follow-up enqueue seam. Defaults to the real `enqueueJob` (translation type +
 * shared dedupe key); tests inject a fake to assert it fires only on new items and to
 * simulate an enqueue failure. Narrowed to a no-arg call because the type and dedupe
 * key are fixed by this orchestration step.
 */
export type EnqueueTranslationFollowup = () => Promise<EnqueueJobResult>;

function defaultEnqueueTranslation(): Promise<EnqueueJobResult> {
  return enqueueJob({
    type: RSS_TRANSLATION_JOB_TYPE,
    dedupeKey: RSS_TRANSLATION_DEDUPE_KEY,
  });
}

/**
 * Compact, operator-facing diagnostics persisted as the job's `result`. A `type`
 * (not `interface`) so it carries an index signature and satisfies `JobResult`
 * (Record<string, unknown>).
 */
export type RssIngestionDiagnostics = {
  runId: string;
  processedSources: number;
  successfulSources: number;
  failedSources: number;
  skippedSources: number;
  remainingSources: number;
  itemsCreated: number;
  itemsUpdated: number;
  durationMs: number;
  timedOut: boolean;
};

export function toDiagnostics(summary: IngestionCronSummary): RssIngestionDiagnostics {
  return {
    runId: summary.runId,
    processedSources: summary.examined,
    successfulSources: summary.succeeded,
    failedSources: summary.failed,
    skippedSources: summary.skipped,
    remainingSources: summary.remaining,
    itemsCreated: summary.itemsCreated,
    itemsUpdated: summary.itemsUpdated,
    durationMs: summary.durationMs,
    timedOut: summary.timedOut,
  };
}

/**
 * Factory so tests can inject the ingestion runner and the follow-up enqueue;
 * production wires the real `runIngestionCron` service and the real `enqueueJob`
 * (each with its own production defaults — the worker never reaches into ingestion
 * or translation internals).
 */
export function createRssIngestionHandler(
  runIngestion: () => Promise<IngestionCronSummary> = () => runIngestionCron(),
  enqueueTranslation: EnqueueTranslationFollowup = defaultEnqueueTranslation
): JobHandler {
  return async ({ job, logger }) => {
    logger.info("rss ingestion starting", { jobId: job.id, attempt: job.attempts });

    const summary = await runIngestion();
    const diagnostics = toDiagnostics(summary);

    if (summary.status === "failed") {
      logger.error("rss ingestion run failed", { jobId: job.id, error: summary.error });
      // Throw so the orchestrator requeues (retry) or fails terminally per policy.
      throw new Error(summary.error ?? "RSS ingestion run failed");
    }

    logger.info("rss ingestion completed", { jobId: job.id, ...diagnostics });

    // Phase 6.0: kick off translation immediately when this run created new feed
    // items. Best-effort — the shared dedupe key collapses this into any in-flight
    // translation job, and a failure here must never retry a successful import
    // (the scheduled translation cron is the backstop), so we log and swallow.
    if (summary.itemsCreated > 0) {
      try {
        const enqueue = await enqueueTranslation();
        logger.info("rss translation follow-up enqueued", {
          jobId: job.id,
          itemsCreated: summary.itemsCreated,
          enqueued: enqueue.enqueued,
          deduplicated: enqueue.deduplicated,
          translationJobId: enqueue.jobId,
        });
      } catch (err) {
        logger.error("rss translation follow-up enqueue failed (ignored)", {
          jobId: job.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return diagnostics;
  };
}

/** The production handler, wired to the real ingestion service + enqueue. */
export const rssIngestionHandler: JobHandler = createRssIngestionHandler();
