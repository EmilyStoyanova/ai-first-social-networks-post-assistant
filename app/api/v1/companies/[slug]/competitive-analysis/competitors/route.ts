import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  listCompetitors,
  type CompetitorListFilter,
} from "@/lib/services/competitive-analysis/list-competitors.service";
import { createCompetitor } from "@/lib/services/competitive-analysis/create-competitor.service";
import { competitorSchema } from "@/lib/validators/competitor.schema";

function parseFilter(raw: string | null): CompetitorListFilter {
  return raw === "archived" || raw === "all" ? raw : "active";
}

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const session = await auth();
  if (!session)
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 }
    );

  const { slug } = await params;
  const filter = parseFilter(new URL(req.url).searchParams.get("status"));

  const result = await listCompetitors(slug, session.user.id, session.user.isGlobalAdmin, filter);

  if (!result.success) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "Not found" } },
      { status: 404 }
    );
  }
  return NextResponse.json({ competitors: result.competitors, isOwner: result.isOwner });
}

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const session = await auth();
  if (!session)
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 }
    );

  const { slug } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: "INVALID_JSON", message: "Invalid JSON" } },
      { status: 400 }
    );
  }

  const parsed = competitorSchema.safeParse(body);
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

  const result = await createCompetitor(
    slug,
    session.user.id,
    session.user.isGlobalAdmin,
    parsed.data
  );

  if (!result.success) {
    const status = result.code === "NOT_FOUND" ? 404 : 403;
    const message = result.code === "NOT_FOUND" ? "Not found" : "Forbidden";
    return NextResponse.json({ error: { code: result.code, message } }, { status });
  }
  return NextResponse.json({ competitor: result.competitor }, { status: 201 });
}
