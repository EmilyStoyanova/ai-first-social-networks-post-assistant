import { NextResponse } from "next/server";
import { verifyCronRequest } from "@/lib/security/cron-auth";
import { enqueueJob } from "@/lib/services/queue/enqueue-job.service";
import { RSS_CLASSIFICATION_JOB_TYPE, RSS_CLASSIFICATION_DEDUPE_KEY } from "@/lib/queue/job-types";

/**
 * Article classification trigger — manual / internal only.
 *
 * Deliberately NOT in vercel.json: the recurring run rides the translation tick
 * (see the translation handler), because Hobby caps both the number of crons and
 * their frequency and because an article is ready to be judged exactly when its
 * translation has settled. This endpoint exists so an operator can drain the
 * queue on demand — after fixing a provider outage, say — without waiting a day.
 */

// Cron work must never be cached or statically optimized.
export const dynamic = "force-dynamic";
// The route only enqueues one job and returns; the worker owns the 240s run.
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

  const result = await enqueueJob({
    type: RSS_CLASSIFICATION_JOB_TYPE,
    dedupeKey: RSS_CLASSIFICATION_DEDUPE_KEY,
  });

  return NextResponse.json({
    data: {
      kind: "classification",
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
