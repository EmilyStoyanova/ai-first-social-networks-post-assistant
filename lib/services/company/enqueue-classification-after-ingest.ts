/**
 * Manual-ingest classification follow-up (orchestration seam).
 *
 * The third sibling of `enqueue-translation-after-ingest.ts` and
 * `enqueue-extraction-after-ingest.ts`, and deliberately their exact shape: after
 * a manual fetch leaves articles needing a verdict, kick off the drain instead of
 * leaving them pending until the next tick. It reuses the classification job type
 * and its SHARED dedupe key (so it collapses into any in-flight drain rather than
 * creating a concurrent one), and is best-effort — a failure is logged and
 * swallowed so a successful fetch is never turned into an error.
 *
 * This is what closes the gap for a source with translation switched OFF: such an
 * ingest creates no translation work, so the translation tick — which is what
 * normally hands over to classification — never runs for it.
 *
 * Extracted from the route purely so the enqueue/no-enqueue decision is
 * unit-testable with an injected enqueue and no database.
 */

import { enqueueJob, type EnqueueJobResult } from "@/lib/services/queue/enqueue-job.service";
import { RSS_CLASSIFICATION_JOB_TYPE, RSS_CLASSIFICATION_DEDUPE_KEY } from "@/lib/queue/job-types";

/** The enqueue seam. Defaults to the real classification enqueue; tests inject a fake. */
export type EnqueueClassificationFollowup = () => Promise<EnqueueJobResult>;

function defaultEnqueueClassification(): Promise<EnqueueJobResult> {
  return enqueueJob({
    type: RSS_CLASSIFICATION_JOB_TYPE,
    dedupeKey: RSS_CLASSIFICATION_DEDUPE_KEY,
    // Above the recurring sweeps: somebody clicked Fetch and is waiting to see
    // what came in and what it is worth.
    priority: 5,
  });
}

/**
 * Enqueue a classification drain iff this ingest left genuine work
 * (`classificationWorkCreated > 0`). Never throws.
 */
export async function enqueueClassificationAfterIngest(
  classificationWorkCreated: number,
  ctx: { slug: string; sourceId: string },
  enqueue: EnqueueClassificationFollowup = defaultEnqueueClassification
): Promise<void> {
  if (classificationWorkCreated <= 0) return;
  try {
    const result = await enqueue();
    console.info("[content-source ingest] classification follow-up enqueued", {
      slug: ctx.slug,
      sourceId: ctx.sourceId,
      classificationWorkCreated,
      enqueued: result.enqueued,
      deduplicated: result.deduplicated,
      classificationJobId: result.jobId,
    });
  } catch (err) {
    console.error("[content-source ingest] classification follow-up enqueue failed (ignored)", err);
  }
}
