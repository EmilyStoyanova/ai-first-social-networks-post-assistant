/**
 * Manual-ingest extraction follow-up (orchestration seam).
 *
 * The sibling of `enqueue-translation-after-ingest.ts`, and deliberately its exact
 * shape: after a manual "Extract" leaves real extraction work, kick off the drain
 * immediately instead of leaving the item pending. It reuses the extraction job
 * type and its SHARED dedupe key (so it collapses into any in-flight drain rather
 * than creating a concurrent one), and is best-effort — a failure is logged and
 * swallowed so a successful fetch is never turned into an error.
 *
 * Extracted from the route purely so the enqueue/no-enqueue decision is
 * unit-testable with an injected enqueue and no database.
 */

import { enqueueJob, type EnqueueJobResult } from "@/lib/services/queue/enqueue-job.service";
import {
  PRODUCT_PAGE_EXTRACTION_JOB_TYPE,
  PRODUCT_PAGE_EXTRACTION_DEDUPE_KEY,
} from "@/lib/queue/job-types";

/** The enqueue seam. Defaults to the real extraction enqueue; tests inject a fake. */
export type EnqueueExtractionFollowup = () => Promise<EnqueueJobResult>;

function defaultEnqueueExtraction(): Promise<EnqueueJobResult> {
  return enqueueJob({
    type: PRODUCT_PAGE_EXTRACTION_JOB_TYPE,
    dedupeKey: PRODUCT_PAGE_EXTRACTION_DEDUPE_KEY,
    // Above the recurring sweeps: somebody clicked Extract and is waiting to see
    // the result before they can generate anything from it.
    priority: 5,
  });
}

/**
 * Enqueue an extraction drain iff this ingest left genuine extraction work
 * (`extractionWorkCreated > 0`). Never throws.
 */
export async function enqueueExtractionAfterIngest(
  extractionWorkCreated: number,
  ctx: { slug: string; sourceId: string },
  enqueue: EnqueueExtractionFollowup = defaultEnqueueExtraction
): Promise<void> {
  if (extractionWorkCreated <= 0) return;
  try {
    const result = await enqueue();
    console.info("[content-source ingest] extraction follow-up enqueued", {
      slug: ctx.slug,
      sourceId: ctx.sourceId,
      extractionWorkCreated,
      enqueued: result.enqueued,
      deduplicated: result.deduplicated,
      extractionJobId: result.jobId,
    });
  } catch (err) {
    console.error("[content-source ingest] extraction follow-up enqueue failed (ignored)", err);
  }
}
