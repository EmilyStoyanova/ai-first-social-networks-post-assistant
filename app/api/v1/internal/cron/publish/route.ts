import { NextResponse } from "next/server";
import { verifyCronRequest } from "@/lib/security/cron-auth";
import { enqueueJob } from "@/lib/services/queue/enqueue-job.service";
import { PUBLISH_SWEEP_JOB_TYPE, PUBLISH_SWEEP_DEDUPE_KEY } from "@/lib/queue/job-types";

// Cron work must never be cached or statically optimized. Load-bearing here: a
// cached 200 would let the scheduler believe it was publishing while nothing ran.
export const dynamic = "force-dynamic";
// The route only enqueues one job and returns; the background worker owns the sweep
// (and its own 240s soft time budget).
export const maxDuration = 60;

/**
 * Publishing sweep trigger — the endpoint an external scheduler calls every 30 minutes.
 *
 * NOT in vercel.json, and deliberately so. Vercel Hobby allows very few scheduled
 * crons and only daily granularity, which is the whole problem: a manually scheduled
 * post is publishable for 90 minutes after its slot (PAST_DUE_GRACE_MS), so a daily
 * sweep would park nearly every one of them instead of sending it. The cadence has to
 * come from outside the platform, so the trigger is an ordinary protected route.
 *
 * Until that scheduler is configured, publishing still happens: the daily generation
 * tick enqueues the same job (lib/services/queue/enqueue-generation-cycle.service.ts).
 * That is a floor, not a second publisher — same type, same dedupe key, same handler,
 * same CronRun record — so the two triggers cannot produce two sweeps. Adding the
 * external scheduler raises the frequency and changes nothing else.
 *
 * Authentication is the existing CRON_SECRET pattern, unchanged: either
 * `Authorization: Bearer <CRON_SECRET>` or `x-api-key: <CRON_SECRET>`, compared in
 * constant time. Most third-party schedulers can send a static header, and the
 * x-api-key form exists for the ones that cannot say "Bearer".
 *
 * Overlap is safe by construction. The route does not publish — it enqueues — and the
 * job's dedupe key collides with the partial unique index on active jobs, so a second
 * call arriving while a sweep is queued or running returns { deduplicated: true } and
 * 200 rather than starting a sweep that would read the same due posts and deliver them
 * to Buffer twice. A scheduler that retries, double-fires, or overlaps a slow run
 * therefore costs one INSERT attempt and nothing else.
 */
async function handle(request: Request) {
  const auth = verifyCronRequest(request);
  if (auth === "not_configured") {
    return NextResponse.json(
      {
        error: {
          code: "CONFIGURATION_ERROR",
          message: "Cron is not configured. Set the CRON_SECRET environment variable.",
        },
      },
      { status: 500 }
    );
  }
  if (auth === "unauthorized") {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Invalid or missing cron credentials." } },
      { status: 401 }
    );
  }

  const result = await enqueueJob({
    type: PUBLISH_SWEEP_JOB_TYPE,
    dedupeKey: PUBLISH_SWEEP_DEDUPE_KEY,
  });

  return NextResponse.json({
    data: {
      kind: "publish",
      enqueued: result.enqueued,
      // Reported rather than hidden: a scheduler whose calls are ALWAYS deduplicated
      // is telling you the sweep is not finishing inside its interval.
      deduplicated: result.deduplicated,
      jobId: result.jobId,
    },
  });
}

// GET is what most external schedulers send by default (and what Vercel Cron would
// use); POST is kept for schedulers configured to POST and for manual invocation.
// Both do exactly the same thing — the job's dedupe key, not the method, is what
// makes a repeat call safe.
export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
