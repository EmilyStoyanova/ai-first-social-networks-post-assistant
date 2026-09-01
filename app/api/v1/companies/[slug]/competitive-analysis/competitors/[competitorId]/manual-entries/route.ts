import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { createManualEntry } from "@/lib/services/competitive-analysis/create-manual-entry.service";
import { competitorManualEntrySchema } from "@/lib/validators/competitor-manual-entry.schema";

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

  const parsed = competitorManualEntrySchema.safeParse(body);
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

  const result = await createManualEntry(
    slug,
    competitorId,
    session.user.id,
    session.user.isGlobalAdmin,
    parsed.data
  );

  if (!result.success) {
    const status = result.code === "NOT_FOUND" ? 404 : result.code === "ARCHIVED" ? 409 : 403;
    const message =
      result.code === "NOT_FOUND"
        ? "Not found"
        : result.code === "ARCHIVED"
          ? "This competitor is archived — restore it before adding content."
          : "Forbidden";
    return NextResponse.json({ error: { code: result.code, message } }, { status });
  }
  return NextResponse.json({ entry: result.entry }, { status: 201 });
}
