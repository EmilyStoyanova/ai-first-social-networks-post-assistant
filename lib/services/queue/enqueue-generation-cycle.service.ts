import { enqueueJob, type EnqueueJobResult } from "./enqueue-job.service";
import {
  POST_GENERATION_JOB_TYPE,
  POST_GENERATION_DEDUPE_KEY,
  ANALYTICS_SYNC_JOB_TYPE,
  ANALYTICS_SYNC_DEDUPE_KEY,
} from "@/lib/queue/job-types";

/**
 * Enqueues the daily generation cycle: the post generation job, then the Buffer
 * analytics refresh.
 *
 * The two travel together because Vercel Hobby allows very few scheduled crons,
 * not because they are one piece of work. They stay SEPARATE queue jobs — own
 * type, own dedupe key, own retry policy, own CronRun record, own diagnostics —
 * so analytics is never executed inline inside the generation run, where a Buffer
 * outage would land on generation's retry policy and its time budget.
 *
 * Ordering and isolation are the point of this module:
 *   • generation is enqueued FIRST and its result is what the caller reports;
 *   • the analytics enqueue is wrapped, so a failure there cannot undo or block
 *     the generation job that is already queued.
 *
 * A failed analytics enqueue costs at most one day's refresh: the next cycle
 * enqueues it again, and the sync itself resumes from whatever is stalest, so
 * nothing is lost beyond the delay.
 */

export interface GenerationCycleResult {
  generation: EnqueueJobResult;
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

  try {
    const analytics = await enqueue({
      type: ANALYTICS_SYNC_JOB_TYPE,
      dedupeKey: ANALYTICS_SYNC_DEDUPE_KEY,
    });
    return { generation, analytics };
  } catch (err) {
    const analyticsError = err instanceof Error ? err.message : "Unknown error.";
    console.error(`[cron] Analytics job could not be enqueued: ${analyticsError}`);
    return { generation, analytics: null, analyticsError };
  }
}
