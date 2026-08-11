import { enqueueJob, type EnqueueJobResult } from "./enqueue-job.service";
import {
  POST_GENERATION_JOB_TYPE,
  POST_GENERATION_DEDUPE_KEY,
  ANALYTICS_SYNC_JOB_TYPE,
  ANALYTICS_SYNC_DEDUPE_KEY,
  PUBLISH_SWEEP_JOB_TYPE,
  PUBLISH_SWEEP_DEDUPE_KEY,
} from "@/lib/queue/job-types";

/**
 * Enqueues the daily generation cycle: the post generation job, then the publishing
 * sweep, then the Buffer analytics refresh.
 *
 * The three travel together because Vercel Hobby allows very few scheduled crons,
 * not because they are one piece of work. They stay SEPARATE queue jobs — own
 * type, own dedupe key, own retry policy, own CronRun record, own diagnostics —
 * so analytics is never executed inline inside the generation run, where a Buffer
 * outage would land on generation's retry policy and its time budget.
 *
 * The publishing sweep is here for a different reason than analytics, and it is
 * worth being precise about: publishing used to be step 5 INSIDE the generation run.
 * It was moved out because a manually scheduled post is only publishable for 90
 * minutes after its slot, which a once-a-day publisher cannot honour — the real
 * trigger is now an external 30-minute scheduler calling /api/v1/internal/cron/publish.
 *
 * What is enqueued here is that SAME job, with that same dedupe key. It is a floor,
 * not a second publisher: before the external scheduler exists, publishing still
 * happens daily exactly as it did; once it exists, this enqueue is either absorbed by
 * the dedupe or runs a sweep that finds nothing new. There is no arrangement of the
 * two triggers that produces two concurrent sweeps, which is what keeps a post from
 * being delivered to Buffer twice.
 *
 * Ordering and isolation are the point of this module:
 *   • generation is enqueued FIRST and its result is what the caller reports;
 *   • the publish and analytics enqueues are wrapped INDIVIDUALLY, so a failure in
 *     either cannot undo the generation job that is already queued, and a failed
 *     publish enqueue does not cost the day its analytics.
 *
 * Generation is enqueued before the sweep so that with the default single-slot
 * worker the two run in the order they always did — generate and auto-approve, then
 * publish — and today's posts still go out on today's tick. Nothing depends on it:
 * a sweep that runs first simply finds the new posts on the following tick.
 *
 * A failed analytics enqueue costs at most one day's refresh; a failed publish
 * enqueue costs at most one tick, and only when no external scheduler is running.
 * Both are re-enqueued by the next cycle, and neither job carries state between
 * runs — each re-derives its work from the database.
 */

export interface GenerationCycleResult {
  generation: EnqueueJobResult;
  /** Null when the publish enqueue threw — see `publishError`. */
  publish: EnqueueJobResult | null;
  publishError?: string;
  /** Null when the analytics enqueue threw — see `analyticsError`. */
  analytics: EnqueueJobResult | null;
  analyticsError?: string;
}

export interface EnqueueGenerationCycleDeps {
  /** Injected in tests; production always uses the real queue. */
  enqueue?: typeof enqueueJob;
}

export async function enqueueGenerationCycle(
  deps: EnqueueGenerationCycleDeps = {}
): Promise<GenerationCycleResult> {
  const enqueue = deps.enqueue ?? enqueueJob;

  // First, and deliberately unguarded: if the queue itself is unreachable the
  // route must fail loudly rather than report a cycle it never started.
  const generation = await enqueue({
    type: POST_GENERATION_JOB_TYPE,
    dedupeKey: POST_GENERATION_DEDUPE_KEY,
  });

  const result: GenerationCycleResult = { generation, publish: null, analytics: null };

  // Separately guarded from analytics below: these two share a tick but not a fate,
  // and publishing is the one whose omission is visible to a reader of the feed.
  try {
    result.publish = await enqueue({
      type: PUBLISH_SWEEP_JOB_TYPE,
      dedupeKey: PUBLISH_SWEEP_DEDUPE_KEY,
    });
  } catch (err) {
    result.publishError = err instanceof Error ? err.message : "Unknown error.";
    console.error(`[cron] Publish sweep could not be enqueued: ${result.publishError}`);
  }

  try {
    result.analytics = await enqueue({
      type: ANALYTICS_SYNC_JOB_TYPE,
      dedupeKey: ANALYTICS_SYNC_DEDUPE_KEY,
    });
  } catch (err) {
    result.analyticsError = err instanceof Error ? err.message : "Unknown error.";
    console.error(`[cron] Analytics job could not be enqueued: ${result.analyticsError}`);
  }

  return result;
}
