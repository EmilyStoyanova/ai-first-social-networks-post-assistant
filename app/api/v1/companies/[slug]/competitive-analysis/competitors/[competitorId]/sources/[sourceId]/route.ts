import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { updateCompetitorSource } from "@/lib/services/competitive-analysis/update-competitor-source.service";
import { deleteCompetitorSource } from "@/lib/services/competitive-analysis/delete-competitor-source.service";
import { competitorSourceSchema } from "@/lib/validators/competitor-source.schema";

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ slug: string; competitorId: string; sourceId: string }> }
) {
  const session = await auth();
  if (!session)
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 }
    );

  const { slug, competitorId, sourceId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: "INVALID_JSON", message: "Invalid JSON" } },
      { status: 400 }
    );
  }

  const parsed = competitorSourceSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          issues: parsed.error.issues,
        },
      },
      { status: 422 }
    );
  }

  const result = await updateCompetitorSource(
    slug,
    competitorId,
    sourceId,
    session.user.id,
    session.user.isGlobalAdmin,
    parsed.data
  );

  if (!result.success) {
    const status = result.code === "NOT_FOUND" ? 404 : 403;
    const message = result.code === "NOT_FOUND" ? "Not found" : "Forbidden";
    return NextResponse.json({ error: { code: result.code, message } }, { status });
  }
  return NextResponse.json({ source: result.source });
}

export async function DELETE(
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
  const result = await deleteCompetitorSource(
    slug,
    competitorId,
    sourceId,
    session.user.id,
    session.user.isGlobalAdmin
  );

  if (!result.success) {
    const status = result.code === "NOT_FOUND" ? 404 : 403;
    const message = result.code === "NOT_FOUND" ? "Not found" : "Forbidden";
    return NextResponse.json({ error: { code: result.code, message } }, { status });
  }
  return NextResponse.json({ success: true });
}
