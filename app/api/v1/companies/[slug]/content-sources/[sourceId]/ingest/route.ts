import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { ingestContentSource } from "@/lib/services/company/ingest-content-source.service";
import { enqueueJob } from "@/lib/services/queue/enqueue-job.service";
import { RSS_TRANSLATION_JOB_TYPE, RSS_TRANSLATION_DEDUPE_KEY } from "@/lib/queue/job-types";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ slug: string; sourceId: string }> }
) {
  const session = await auth();
  if (!session)
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 }
    );

  const { slug, sourceId } = await params;

  let result: Awaited<ReturnType<typeof ingestContentSource>>;
  try {
    result = await ingestContentSource(slug, sourceId, session.user.id, session.user.isGlobalAdmin);
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
    return NextResponse.json(
      { error: { code: "INGEST_FAILED", message: result.message ?? "Ingestion failed" } },
      { status: 502 }
    );
  }

  // Mirror the worker ingestion handler's follow-up (Phase 6.0): when this manual fetch
  // created new feed items, kick off translation immediately instead of leaving them
  // pending until the daily translation cron. Reuses the existing translation job type +
  // SHARED dedupe key, so it collapses into any in-flight translation run and never
  // creates a concurrent one. Best-effort — a failure here must never fail a successful
  // fetch (the scheduled translation cron is the backstop), so we log and swallow.
  if (result.created > 0) {
    try {
      const enqueue = await enqueueJob({
        type: RSS_TRANSLATION_JOB_TYPE,
        dedupeKey: RSS_TRANSLATION_DEDUPE_KEY,
      });
      console.info("[content-source ingest] translation follow-up enqueued", {
        slug,
        sourceId,
        created: result.created,
        enqueued: enqueue.enqueued,
        deduplicated: enqueue.deduplicated,
        translationJobId: enqueue.jobId,
      });
    } catch (err) {
      console.error("[content-source ingest] translation follow-up enqueue failed (ignored)", err);
    }
  }

  return NextResponse.json({ created: result.created, updated: result.updated });
}
