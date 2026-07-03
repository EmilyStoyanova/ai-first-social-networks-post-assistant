import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { ingestContentSource } from "@/lib/services/company/ingest-content-source.service";

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
  const result = await ingestContentSource(
    slug,
    sourceId,
    session.user.id,
    session.user.isGlobalAdmin
  );

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

  return NextResponse.json({ created: result.created, updated: result.updated });
}
