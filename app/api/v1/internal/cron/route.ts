import { NextResponse } from "next/server";
import { verifyCronRequest } from "@/lib/security/cron-auth";
import { runCron } from "@/lib/services/cron/run-cron.service";

// DEPRECATED (v2-9): the combined one-company-per-run pipeline. Superseded by the split
// crons /api/v1/internal/cron/ingest and /api/v1/internal/cron/generate, which vercel.json
// now schedules instead. Retained for manual/backwards-compatible invocation only — do NOT
// schedule it alongside the generation cron, as both advance Company.lastCronProcessedAt.
//
// It no longer publishes inline. Its step 5 enqueues the publishing sweep instead of
// calling publishScheduledPosts, so invoking this route while a sweep is running is safe:
// the enqueue is deduplicated rather than starting a second publisher. Delivery is
// therefore asynchronous here — it needs the worker running — and global rather than
// scoped to this run's one company. The response shape is unchanged; `actions.publish`
// now reports the enqueue result. Prefer /api/v1/internal/cron/publish to trigger
// publishing directly.

// Cron work must never be cached or statically optimized.
export const dynamic = "force-dynamic";
// Allow the full Vercel Hobby function budget for LLM + Buffer calls.
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

  const summary = await runCron();

  if (summary.status === "failed") {
    return NextResponse.json(
      { error: { code: "CRON_RUN_FAILED", message: summary.error }, data: summary },
      { status: 500 }
    );
  }
  return NextResponse.json({ data: summary });
}

// Vercel Cron invokes GET; POST is kept for manual/external triggering.
export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
