/**
 * RSS translation job handler — a THIN ADAPTER over the existing cron service.
 *
 * The worker is an orchestrator only: this handler contains no translation logic
 * (and no AI logic). It delegates to `runTranslationCron` (the same service the cron
 * route used to call inline), maps its summary to compact job-result diagnostics, and
 * re-throws on a top-level failure so the queue applies its retry / terminal-failure
 * policy.
 *
 * Note: `runTranslationCron` already isolates per-company failures (one bad company does
 * not fail the run), so a completed run with `failedCompanies > 0` is NOT retried — only
 * a genuine run-level failure (status "failed") throws.
 */

import type { JobHandler } from "./handler-registry";
import {
  runTranslationCron,
  type TranslationCronSummary,
} from "@/lib/services/cron/run-translation-cron.service";
import { RSS_TRANSLATION_JOB_TYPE } from "@/lib/queue/job-types";

export { RSS_TRANSLATION_JOB_TYPE };

/**
 * Compact, operator-facing diagnostics persisted as the job's `result`. A `type`
 * (not `interface`) so it carries an index signature and satisfies `JobResult`
 * (Record<string, unknown>).
 */
export type RssTranslationDiagnostics = {
  runId: string;
  examinedCompanies: number;
  processedCompanies: number;
  failedCompanies: number;
  translated: number;
  failed: number;
  skipped: number;
  remaining: number;
  durationMs: number;
  timedOut: boolean;
};

export function toDiagnostics(summary: TranslationCronSummary): RssTranslationDiagnostics {
  return {
    runId: summary.runId,
    examinedCompanies: summary.companiesExamined,
    processedCompanies: summary.companiesProcessed,
    failedCompanies: summary.failures.length,
    translated: summary.translated,
    failed: summary.failed,
    skipped: summary.skipped,
    remaining: summary.remaining,
    durationMs: summary.durationMs,
    timedOut: summary.timedOut,
  };
}

/**
 * Factory so tests can inject the translation runner; production wires the real
 * `runTranslationCron` service (with its own production defaults — the worker never
 * reaches into translation internals).
 */
export function createRssTranslationHandler(
  runTranslation: () => Promise<TranslationCronSummary> = () => runTranslationCron()
): JobHandler {
  return async ({ job, logger }) => {
    logger.info("rss translation starting", { jobId: job.id, attempt: job.attempts });

    const summary = await runTranslation();
    const diagnostics = toDiagnostics(summary);

    if (summary.status === "failed") {
      logger.error("rss translation run failed", { jobId: job.id, error: summary.error });
      // Throw so the orchestrator requeues (retry) or fails terminally per policy.
      throw new Error(summary.error ?? "RSS translation run failed");
    }

    logger.info("rss translation completed", { jobId: job.id, ...diagnostics });
    return diagnostics;
  };
}

/** The production handler, wired to the real translation service. */
export const rssTranslationHandler: JobHandler = createRssTranslationHandler();
