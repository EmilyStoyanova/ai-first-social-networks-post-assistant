import { NextResponse } from "next/server";
import { verifyCronRequest } from "@/lib/security/cron-auth";
import { runIngestionCron } from "@/lib/services/cron/run-ingestion-cron.service";

// Cron work must never be cached or statically optimized.
export const dynamic = "force-dynamic";
// Allow the full Vercel Hobby function budget for feed fetch + translation LLM calls.
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

  const summary = await runIngestionCron();

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
