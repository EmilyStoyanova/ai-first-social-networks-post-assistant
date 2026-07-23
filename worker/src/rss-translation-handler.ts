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
 *
 * Self-continuation: each run drains only a bounded batch (company/item caps + soft time
 * budget), so a large backlog leaves `remaining > 0`. After a COMPLETED run with items
 * still eligible, this handler enqueues ANOTHER translation job so the backlog drains
 * across back-to-back worker runs instead of waiting for the once-a-day scheduled cron.
 * This is pure orchestration — it reuses the existing translation job type and the SHARED
 * dedupe key (so it can never create a second concurrent run and duplicates no translation
 * logic), and mirrors the ingestion → translation follow-up pattern. The enqueue is
 * best-effort: a failure is logged and swallowed (a successful run must not be retried),
 * and the scheduled translation cron remains the backstop.
 */

import type { JobHandler } from "./handler-registry";
import {
  runTranslationCron,
  type TranslationCronSummary,
} from "@/lib/services/cron/run-translation-cron.service";
import { enqueueJob, type EnqueueJobResult } from "@/lib/services/queue/enqueue-job.service";
import { RSS_TRANSLATION_JOB_TYPE, RSS_TRANSLATION_DEDUPE_KEY } from "@/lib/queue/job-types";

export { RSS_TRANSLATION_JOB_TYPE };

/**
 * The continuation enqueue seam. Defaults to the real `enqueueJob` (translation type +
 * shared dedupe key); tests inject a fake to assert it fires only when work remains and
 * to simulate an enqueue failure. Narrowed to a no-arg call because the type and dedupe
 * key are fixed by this orchestration step.
 */
export type EnqueueTranslationContinuation = () => Promise<EnqueueJobResult>;

function defaultEnqueueTranslationContinuation(): Promise<EnqueueJobResult> {
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
 * Factory so tests can inject the translation runner and the continuation enqueue;
 * production wires the real `runTranslationCron` service and the real `enqueueJob`
 * (each with its own production defaults — the worker never reaches into translation
 * internals).
 */
export function createRssTranslationHandler(
  runTranslation: () => Promise<TranslationCronSummary> = () => runTranslationCron(),
  enqueueContinuation: EnqueueTranslationContinuation = defaultEnqueueTranslationContinuation
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

    // Self-continuation: this run drained one bounded batch; if items remain eligible,
    // chain another run so the backlog drains promptly instead of waiting a full day for
    // the scheduled cron. Best-effort — the shared dedupe key collapses this into any
    // in-flight translation job, and a failure here must never retry a successful run
    // (the scheduled translation cron is the backstop), so we log and swallow.
    if (summary.remaining > 0) {
      try {
        const enqueue = await enqueueContinuation();
        logger.info("rss translation continuation enqueued", {
          jobId: job.id,
          remaining: summary.remaining,
          enqueued: enqueue.enqueued,
          deduplicated: enqueue.deduplicated,
          continuationJobId: enqueue.jobId,
        });
      } catch (err) {
        logger.error("rss translation continuation enqueue failed (ignored)", {
          jobId: job.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return diagnostics;
  };
}

/** The production handler, wired to the real translation service + continuation enqueue. */
export const rssTranslationHandler: JobHandler = createRssTranslationHandler();
