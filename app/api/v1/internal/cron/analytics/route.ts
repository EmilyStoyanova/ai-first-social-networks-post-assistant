import { NextResponse } from "next/server";
import { verifyCronRequest } from "@/lib/security/cron-auth";
import { enqueueJob } from "@/lib/services/queue/enqueue-job.service";
import { ANALYTICS_SYNC_JOB_TYPE, ANALYTICS_SYNC_DEDUPE_KEY } from "@/lib/queue/job-types";

// Cron work must never be cached or statically optimized.
export const dynamic = "force-dynamic";
// The route only enqueues one job and returns; the background worker owns the run
// (and its own 240s soft time budget).
export const maxDuration = 60;

/**
 * Buffer analytics refresh trigger — manual / internal only.
 *
 * NOT in vercel.json. Vercel Hobby allows very few scheduled crons, so the daily
 * analytics job is enqueued by the generation cron tick instead
 * (lib/services/queue/enqueue-generation-cycle.service.ts). This route stays for
 * operators: re-running after a backlog day, draining a company that hit its
 * request budget, or verifying a key change without waiting for tomorrow.
 *
 * It enqueues exactly the same job as the scheduled path — same type, same dedupe
 * key, same handler, same CronRun record — so a manual trigger cannot behave
 * differently from the automatic one. The dedupeKey means firing it while a run is
 * in flight returns { deduplicated: true } rather than starting a second run that
 * would re-read the same stalest posts.
 *
 * Extra runs are cheap when there is nothing left: posts already read today are
 * filtered out, so an idle run makes zero Buffer requests.
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
    type: ANALYTICS_SYNC_JOB_TYPE,
    dedupeKey: ANALYTICS_SYNC_DEDUPE_KEY,
  });

  return NextResponse.json({
    data: {
      kind: "analytics",
      enqueued: result.enqueued,
      deduplicated: result.deduplicated,
      jobId: result.jobId,
    },
  });
}

// Vercel Cron invokes GET; POST is kept for manual/external triggering.
export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
