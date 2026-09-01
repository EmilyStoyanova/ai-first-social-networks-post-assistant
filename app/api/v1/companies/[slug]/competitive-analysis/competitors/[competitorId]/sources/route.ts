import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { listCompetitorSources } from "@/lib/services/competitive-analysis/list-competitor-sources.service";
import { createCompetitorSource } from "@/lib/services/competitive-analysis/create-competitor-source.service";
import { competitorSourceSchema } from "@/lib/validators/competitor-source.schema";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string; competitorId: string }> }
) {
  const session = await auth();
  if (!session)
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 }
    );

  const { slug, competitorId } = await params;
  const result = await listCompetitorSources(
    slug,
    competitorId,
    session.user.id,
    session.user.isGlobalAdmin
  );

  if (!result.success) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "Not found" } },
      { status: 404 }
    );
  }
  return NextResponse.json({ sources: result.sources });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string; competitorId: string }> }
) {
  const session = await auth();
  if (!session)
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 }
    );

  const { slug, competitorId } = await params;

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

  const result = await createCompetitorSource(
    slug,
    competitorId,
    session.user.id,
    session.user.isGlobalAdmin,
    parsed.data
  );

  if (!result.success) {
    const status = result.code === "NOT_FOUND" ? 404 : 403;
    const message = result.code === "NOT_FOUND" ? "Not found" : "Forbidden";
    return NextResponse.json({ error: { code: result.code, message } }, { status });
  }
  return NextResponse.json({ source: result.source }, { status: 201 });
}
