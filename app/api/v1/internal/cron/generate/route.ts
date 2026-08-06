import { NextResponse } from "next/server";
import { verifyCronRequest } from "@/lib/security/cron-auth";
import { enqueueGenerationCycle } from "@/lib/services/queue/enqueue-generation-cycle.service";

// Cron work must never be cached or statically optimized.
export const dynamic = "force-dynamic";
// The route no longer runs generation inline — it only enqueues jobs and returns.
// A short cap is ample for two INSERTs; the background worker owns the runs (each
// keeps its own soft time budget and out-of-band deadline, both unchanged).
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

  // Enqueues the day's generation job AND the Buffer analytics job — two separate
  // queue jobs, one trigger. Vercel Hobby allows very few scheduled crons, so
  // analytics rides on this tick rather than owning a schedule entry; it is still
  // never run inline inside generation. Each job's stable dedupeKey means an
  // overlapping tick returns { deduplicated: true } instead of a second run.
  const cycle = await enqueueGenerationCycle();

  return NextResponse.json({
    data: {
      kind: "generation",
      enqueued: cycle.generation.enqueued,
      deduplicated: cycle.generation.deduplicated,
      jobId: cycle.generation.jobId,
      // Reported alongside, never in place of: a failed analytics enqueue leaves
      // generation queued and shows up here as `analytics: null` with a reason.
      analytics: cycle.analytics && {
        enqueued: cycle.analytics.enqueued,
        deduplicated: cycle.analytics.deduplicated,
        jobId: cycle.analytics.jobId,
      },
      ...(cycle.analyticsError ? { analyticsError: cycle.analyticsError } : {}),
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
