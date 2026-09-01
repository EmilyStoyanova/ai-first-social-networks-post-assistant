/**
 * Relevance recompute job handler — a THIN ADAPTER over
 * `recomputeStaleRelevanceForCompany` (Part 3B §12/§13). `companyId` travels
 * in the job's payload (validated here) rather than relying on the `jobs`
 * table's own `companyId` column, which a handler never receives — see
 * `worker/src/job-store.ts`'s `JobRecord`.
 *
 * Self-continuation mirrors the extraction/classification/translation
 * handlers': the continuation carries NO dedupe key. This was a genuine bug
 * found in the verification pass (§2): an earlier version of this file
 * passed `competitorRelevanceDedupeKey(companyId)` on the continuation, which
 * meant the continuation ALWAYS collided with its own still-active parent
 * (the partial unique index blocks a second queued/active row sharing a key)
 * — `enqueueContinuation` reported `deduplicated: true` and no row was ever
 * inserted, so a company with more stale rows than one batch could process
 * would silently stop after exactly one batch. Fixed by dropping the key here
 * — the FIRST enqueue (`update-research-profile.service.ts`, on a Save, or
 * `run-competitor-intelligence-extraction.service.ts`, after a successful
 * extraction) still carries the key, so several independent triggers in
 * quick succession still collapse into one drain; only the self-continuation,
 * which runs from INSIDE the still-active parent, omits it.
 *
 * ── 2026-09 relevance-retry fix ──────────────────────────────────────────
 * The continuation used to fire on `summary.remaining > 0` alone, with no
 * progress guard — see `recompute-stale-relevance.service.ts`'s module
 * comment for the hot-loop this allowed for a permanently-failing row. Now
 * requires `summary.progressed` too, exactly mirroring
 * `competitor-intelligence-extraction-handler.ts`'s own guard.
 */

import type { JobHandler } from "./handler-registry";
import {
  recomputeStaleRelevanceForCompany,
  type RecomputeStaleRelevanceSummary,
} from "@/lib/services/competitive-analysis/recompute-stale-relevance.service";
import { enqueueJob, type EnqueueJobResult } from "@/lib/services/queue/enqueue-job.service";
import { COMPETITOR_RELEVANCE_JOB_TYPE } from "@/lib/queue/job-types";

export { COMPETITOR_RELEVANCE_JOB_TYPE };

export type EnqueueRelevanceContinuation = (companyId: string) => Promise<EnqueueJobResult>;

/**
 * NO dedupeKey — see the module comment. The spawning job is still `active`
 * and holds `competitorRelevanceDedupeKey(companyId)` for the whole duration
 * of this handler; reusing that key here would dedupe the continuation
 * against its own parent and it would never actually enqueue.
 */
export function defaultEnqueueRelevanceContinuation(
  companyId: string,
  enqueue: typeof enqueueJob = enqueueJob
): Promise<EnqueueJobResult> {
  return enqueue({
    type: COMPETITOR_RELEVANCE_JOB_TYPE,
    payload: { companyId },
  });
}

function readCompanyId(payload: unknown): string | null {
  if (payload && typeof payload === "object" && "companyId" in payload) {
    const value = (payload as { companyId: unknown }).companyId;
    return typeof value === "string" && value.trim() !== "" ? value : null;
  }
  return null;
}

export function createCompetitorRelevanceHandler(
  recompute: (
    companyId: string
  ) => Promise<RecomputeStaleRelevanceSummary> = recomputeStaleRelevanceForCompany,
  enqueueContinuation: EnqueueRelevanceContinuation = (companyId) =>
    defaultEnqueueRelevanceContinuation(companyId)
): JobHandler {
  return async ({ job, logger }) => {
    const companyId = readCompanyId(job.payload);
    if (!companyId) {
      // Malformed payload — nothing to retry into a different outcome. Logged
      // and completed as a no-op rather than thrown, so it does not burn the
      // job's retry budget on a payload that will never become valid.
      logger.error("competitor relevance recompute missing companyId — skipping", {
        jobId: job.id,
      });
      return { skipped: true, reason: "missing_company_id" };
    }

    logger.info("competitor relevance recompute starting", {
      jobId: job.id,
      companyId,
      attempt: job.attempts,
    });

    const summary = await recompute(companyId);

    logger.info("competitor relevance recompute completed", { jobId: job.id, ...summary });

    if (summary.remaining > 0 && summary.progressed) {
      try {
        const enqueue = await enqueueContinuation(companyId);
        logger.info("competitor relevance recompute continuation enqueued", {
          jobId: job.id,
          companyId,
          remaining: summary.remaining,
          enqueued: enqueue.enqueued,
          deduplicated: enqueue.deduplicated,
          continuationJobId: enqueue.jobId,
        });
      } catch (err) {
        logger.error("competitor relevance recompute continuation enqueue failed (ignored)", {
          jobId: job.id,
          companyId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (summary.remaining > 0) {
      logger.info("competitor relevance recompute continuation withheld — no progress", {
        jobId: job.id,
        companyId,
        remaining: summary.remaining,
      });
    }

    return summary;
  };
}

export const competitorRelevanceHandler: JobHandler = createCompetitorRelevanceHandler();
