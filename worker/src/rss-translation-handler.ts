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
 * This is pure orchestration — it reuses the existing translation job type and duplicates
 * no translation logic. The continuation carries NO dedupe key: it is enqueued while the
 * spawning job is still `active` holding the shared key, so reusing that key would dedupe
 * the continuation against its own parent and it would never enqueue (see
 * `EnqueueTranslationContinuation`). The enqueue is best-effort: a failure is logged and
 * swallowed (a successful run must not be retried), and the scheduled translation cron
 * remains the backstop.
 */

import type { JobHandler } from "./handler-registry";
import {
  runTranslationCron,
  type TranslationCronSummary,
} from "@/lib/services/cron/run-translation-cron.service";
import { enqueueJob, type EnqueueJobResult } from "@/lib/services/queue/enqueue-job.service";
import {
  RSS_TRANSLATION_JOB_TYPE,
  RSS_CLASSIFICATION_JOB_TYPE,
  RSS_CLASSIFICATION_DEDUPE_KEY,
} from "@/lib/queue/job-types";

export { RSS_TRANSLATION_JOB_TYPE };

/**
 * The continuation enqueue seam. Defaults to the real `enqueueJob` (translation type,
 * NO dedupe key); tests inject a fake to assert it fires only when work remains and to
 * simulate an enqueue failure. Narrowed to a no-arg call because the type is fixed by
 * this orchestration step.
 *
 * Why no dedupe key: this enqueue runs INSIDE the handler, before the orchestrator marks
 * the spawning job `completed`, so that job is still `status='active'` holding the shared
 * key `cron:rss-translation`. Reusing that key would collide with the parent's own row in
 * the partial unique index `jobs_dedupe_active_key (WHERE status IN ('queued','active'))`,
 * so the continuation would always dedupe against itself and never enqueue — and any fixed
 * key has the same flaw, since each continuation would in turn block its own successor.
 * The continuation is inherently sequential (claimed only after the parent leaves the
 * active set on a single worker), so it needs no active-dedupe guard; the scheduled
 * translation cron keeps its shared-key guard against overlapping ticks.
 */
export type EnqueueTranslationContinuation = () => Promise<EnqueueJobResult>;

/**
 * Enqueues the continuation job. Exported with the `enqueue` seam injectable so a test can
 * assert the exact input (crucially: NO dedupeKey) without a database; production calls it
 * with no args, using the real `enqueueJob`.
 */
export function defaultEnqueueTranslationContinuation(
  enqueue: typeof enqueueJob = enqueueJob
): Promise<EnqueueJobResult> {
  return enqueue({
    type: RSS_TRANSLATION_JOB_TYPE,
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
/**
 * The classification hand-off seam.
 *
 * Classification rides this tick rather than a scheduled cron of its own — Vercel
 * Hobby caps both the number of crons and their frequency — and this is the right
 * tick for it on the merits, not only for the quota: a verdict is made from the
 * TRANSLATED text, so an article is ready to be judged exactly when its
 * translation has settled.
 *
 * Unlike the continuation above it DOES carry its dedupe key: it is a different
 * job type, so there is no self-collision, and the key is what makes a manual
 * ingest, a topic-settings save and this tick finishing together collapse into
 * one drain instead of racing over the same articles.
 */
export type EnqueueClassificationAfterTranslation = () => Promise<EnqueueJobResult>;

export function defaultEnqueueClassificationAfterTranslation(
  enqueue: typeof enqueueJob = enqueueJob
): Promise<EnqueueJobResult> {
  return enqueue({
    type: RSS_CLASSIFICATION_JOB_TYPE,
    dedupeKey: RSS_CLASSIFICATION_DEDUPE_KEY,
  });
}

export function createRssTranslationHandler(
  runTranslation: () => Promise<TranslationCronSummary> = () => runTranslationCron(),
  enqueueContinuation: EnqueueTranslationContinuation = defaultEnqueueTranslationContinuation,
  enqueueClassification: EnqueueClassificationAfterTranslation = defaultEnqueueClassificationAfterTranslation
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
    // the scheduled cron. Best-effort — the continuation carries no dedupe key (it would
    // otherwise collide with this still-active parent), and a failure here must never
    // retry a successful run (the scheduled translation cron is the backstop), so we log
    // and swallow.
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
    } else {
      // The translation backlog is drained, so every article that was going to
      // change its text has changed it: hand off to classification. Guarded and
      // swallowed for the same reason the continuation is — a successful
      // translation run must never be retried because a downstream enqueue
      // failed, and the next tick re-enqueues it anyway.
      try {
        const enqueue = await enqueueClassification();
        logger.info("rss classification enqueued after translation", {
          jobId: job.id,
          enqueued: enqueue.enqueued,
          deduplicated: enqueue.deduplicated,
          classificationJobId: enqueue.jobId,
        });
      } catch (err) {
        logger.error("rss classification enqueue failed (ignored)", {
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
