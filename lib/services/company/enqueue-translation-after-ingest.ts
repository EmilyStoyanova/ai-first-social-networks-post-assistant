/**
 * Manual-ingest translation follow-up (orchestration seam).
 *
 * After a manual "Fetch/Extract" produces real translation work, kick off translation
 * immediately instead of leaving items pending until the daily cron. Mirrors the worker
 * ingestion handler's follow-up: it reuses the existing translation job type + the SHARED
 * dedupe key (so it collapses into any in-flight translation run and never creates a
 * concurrent one), and is best-effort — a failure is logged and swallowed so a successful
 * fetch is never turned into an error (the scheduled translation cron is the backstop).
 *
 * Extracted from the route (rather than inlined) purely so the enqueue/no-enqueue decision
 * is unit-testable with an injected enqueue and no database.
 */

import { enqueueJob, type EnqueueJobResult } from "@/lib/services/queue/enqueue-job.service";
import { RSS_TRANSLATION_JOB_TYPE, RSS_TRANSLATION_DEDUPE_KEY } from "@/lib/queue/job-types";

/** The enqueue seam. Defaults to the real translation enqueue; tests inject a fake. */
export type EnqueueTranslationFollowup = () => Promise<EnqueueJobResult>;

function defaultEnqueueTranslation(): Promise<EnqueueJobResult> {
  return enqueueJob({
    type: RSS_TRANSLATION_JOB_TYPE,
    dedupeKey: RSS_TRANSLATION_DEDUPE_KEY,
  });
}

/**
 * Enqueue a translation job iff this ingest left genuine translation work
 * (`translationWorkCreated > 0`). Never throws — enqueue failures are logged and swallowed.
 */
export async function enqueueTranslationAfterIngest(
  translationWorkCreated: number,
  ctx: { slug: string; sourceId: string },
  enqueue: EnqueueTranslationFollowup = defaultEnqueueTranslation
): Promise<void> {
  if (translationWorkCreated <= 0) return;
  try {
    const result = await enqueue();
    console.info("[content-source ingest] translation follow-up enqueued", {
      slug: ctx.slug,
      sourceId: ctx.sourceId,
      translationWorkCreated,
      enqueued: result.enqueued,
      deduplicated: result.deduplicated,
      translationJobId: result.jobId,
    });
  } catch (err) {
    console.error("[content-source ingest] translation follow-up enqueue failed (ignored)", err);
  }
}
