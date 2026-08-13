/**
 * Reads the state of one queued bulk generation, for the person who asked for it.
 *
 * The access rules — scoped by company AND type, and never returning `payload` —
 * live in `job-status.ts` and are shared with the topic-generation status read.
 * This module is what remains once those are factored out: the job type, the
 * reader for THIS type's progress, and the names the bulk UI already imports.
 *
 * `result` IS returned, because that is the batch summary itself — the same
 * object the synchronous route used to answer with, written progressively as the
 * run commits each topic. The UI polls this and renders from it directly.
 */

import {
  readJobStatus,
  toJobState,
  type JobRow,
  type JobStatusDeps,
  type JobStatusView,
  type JobLifecycleState,
} from "./job-status";
import {
  parseBulkGenerationProgress,
  type BulkGenerationProgress,
} from "@/lib/queue/bulk-generation-payload";
import { BULK_GENERATION_JOB_TYPE } from "@/lib/queue/job-types";

// Re-exported because the bulk UI and its tests have always imported these from
// here. They are now aliases of the shared shapes rather than separate
// declarations, so the two status endpoints cannot drift on what a job row says.
export type { JobRow };
export { toJobState };

/** @see JobLifecycleState — kept under the bulk name its callers already use. */
export type BulkGenerationJobState = JobLifecycleState;

export type BulkGenerationStatus = JobStatusView<BulkGenerationProgress>;

export type GetBulkGenerationStatusResult =
  { success: true; data: BulkGenerationStatus } | { success: false; code: "NOT_FOUND" };

export type GetBulkGenerationStatusDeps = JobStatusDeps;

export async function getBulkGenerationStatus(
  slug: string,
  jobId: string,
  userId: string,
  isGlobalAdmin: boolean,
  deps: GetBulkGenerationStatusDeps = {}
): Promise<GetBulkGenerationStatusResult> {
  return readJobStatus({
    slug,
    jobId,
    userId,
    isGlobalAdmin,
    type: BULK_GENERATION_JOB_TYPE,
    // Parsed rather than passed through raw: this crosses back out to a client,
    // and an unparseable diary entry should read as "nothing yet", not as an
    // arbitrary blob shaped by whatever last wrote to the column.
    parseProgress: parseBulkGenerationProgress,
    deps,
  });
}
