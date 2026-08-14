import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { ingestContentSource } from "@/lib/services/company/ingest-content-source.service";
import { enqueueTranslationAfterIngest } from "@/lib/services/company/enqueue-translation-after-ingest";
import { enqueueExtractionAfterIngest } from "@/lib/services/company/enqueue-extraction-after-ingest";

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

  // Kick off translation immediately when this manual fetch produced genuine translation
  // work — the precise `translationWorkCreated` signal, not created/updated (an RSS feed
  // re-lists unchanged items every poll, which are NOT translation work). Best-effort and
  // swallowed, so it never affects the response below.
  await enqueueTranslationAfterIngest(result.translationWorkCreated, { slug, sourceId });

  // The same, for a product page whose instruction says what to take from it. The
  // scrape happened above; turning the page into the requested facts is an LLM
  // call and belongs to a worker, not to this request — see
  // run-pending-extractions.service.ts.
  await enqueueExtractionAfterIngest(result.extractionWorkCreated, { slug, sourceId });

  return NextResponse.json({ created: result.created, updated: result.updated });
}
