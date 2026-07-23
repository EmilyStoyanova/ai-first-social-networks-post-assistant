import { NextResponse } from "next/server";
import { verifyCronRequest } from "@/lib/security/cron-auth";
import { enqueueJob } from "@/lib/services/queue/enqueue-job.service";
import { POST_GENERATION_JOB_TYPE, POST_GENERATION_DEDUPE_KEY } from "@/lib/queue/job-types";

// Cron work must never be cached or statically optimized.
export const dynamic = "force-dynamic";
// The route no longer runs generation inline — it only enqueues one job and returns.
// A short cap is ample for a single INSERT; the background worker owns the run (which
// keeps its own 240s soft time budget and out-of-band deadline, both unchanged).
export const maxDuration = 60;

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

  // Enqueue a single post generation job for the worker to run. The stable dedupeKey
  // means an overlapping cron tick returns { deduplicated: true } instead of
  // creating a second concurrent run.
  const result = await enqueueJob({
    type: POST_GENERATION_JOB_TYPE,
    dedupeKey: POST_GENERATION_DEDUPE_KEY,
  });

  return NextResponse.json({
    data: {
      kind: "generation",
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
