import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { ingestCompetitorSource } from "@/lib/services/competitive-analysis/ingest-competitor-source.service";
import { enqueueJob } from "@/lib/services/queue/enqueue-job.service";
import {
  COMPETITOR_INTELLIGENCE_EXTRACTION_JOB_TYPE,
  COMPETITOR_INTELLIGENCE_EXTRACTION_DEDUPE_KEY,
} from "@/lib/queue/job-types";

/**
 * Manual "Sync RSS" trigger (§19) — the controlled way to ingest a
 * competitor's feed in this phase. No automatic/cron sweep exists yet for
 * competitor sources; this is the only ingestion entry point besides a future
 * cron tick.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ slug: string; competitorId: string; sourceId: string }> }
) {
  const session = await auth();
  if (!session)
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 }
    );

  const { slug, competitorId, sourceId } = await params;

  let result: Awaited<ReturnType<typeof ingestCompetitorSource>>;
  try {
    result = await ingestCompetitorSource(
      slug,
      competitorId,
      sourceId,
      session.user.id,
      session.user.isGlobalAdmin
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Ingestion failed unexpectedly";
    return NextResponse.json({ error: { code: "INGEST_FAILED", message } }, { status: 500 });
  }

  if (!result.success) {
    if (result.code === "NOT_FOUND")
      return NextResponse.json(
        { error: { code: "NOT_FOUND", message: "Not found" } },
        { status: 404 }
      );
    if (result.code === "FORBIDDEN")
      return NextResponse.json(
        { error: { code: "FORBIDDEN", message: "Forbidden" } },
        { status: 403 }
      );
    if (result.code === "ARCHIVED")
      return NextResponse.json(
        {
          error: {
            code: "ARCHIVED",
            message: "This competitor is archived — restore it before syncing.",
          },
        },
        { status: 409 }
      );
    return NextResponse.json(
      { error: { code: "INGEST_FAILED", message: result.message ?? "Ingestion failed" } },
      { status: 502 }
    );
  }

  // Best-effort: kick off extraction for whatever this sync just wrote.
  // Competitor ingestion NEVER enqueues normal translation/extraction/
  // classification (§4) — only the dedicated Competitive Intelligence drain.
  if (result.created + result.updated > 0) {
    try {
      await enqueueJob({
        type: COMPETITOR_INTELLIGENCE_EXTRACTION_JOB_TYPE,
        dedupeKey: COMPETITOR_INTELLIGENCE_EXTRACTION_DEDUPE_KEY,
      });
    } catch (err) {
      console.error("[competitor-source-ingest] extraction enqueue failed (ignored):", err);
    }
  }

  return NextResponse.json({ created: result.created, updated: result.updated });
}
