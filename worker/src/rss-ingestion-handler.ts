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
 */

import type { JobHandler } from "./handler-registry";
import {
  runIngestionCron,
  type IngestionCronSummary,
} from "@/lib/services/cron/run-ingestion-cron.service";
import { RSS_INGESTION_JOB_TYPE } from "@/lib/queue/job-types";

export { RSS_INGESTION_JOB_TYPE };

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
 * Factory so tests can inject the ingestion runner; production wires the real
 * `runIngestionCron` service (with its own production defaults — the worker never
 * reaches into ingestion internals).
 */
export function createRssIngestionHandler(
  runIngestion: () => Promise<IngestionCronSummary> = () => runIngestionCron()
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
    return diagnostics;
  };
}

/** The production handler, wired to the real ingestion service. */
export const rssIngestionHandler: JobHandler = createRssIngestionHandler();
