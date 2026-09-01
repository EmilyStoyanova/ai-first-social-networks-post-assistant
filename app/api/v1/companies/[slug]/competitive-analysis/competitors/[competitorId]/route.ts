import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { updateCompetitor } from "@/lib/services/competitive-analysis/update-competitor.service";
import { deleteCompetitor } from "@/lib/services/competitive-analysis/delete-competitor.service";
import { competitorSchema } from "@/lib/validators/competitor.schema";

export async function PUT(
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

  const result = await updateCompetitor(
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
  return NextResponse.json({ competitor: result.competitor });
}

// PERMANENT delete only — a separate, explicit destructive action from
// archive/restore (§11/§13 of the Part 3A task). The UI gates this behind its
// own confirm-typed-name dialog, never the same control as Archive.
export async function DELETE(
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
  const result = await deleteCompetitor(
    slug,
    competitorId,
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
