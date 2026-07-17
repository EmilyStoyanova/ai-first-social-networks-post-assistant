import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getContentMix } from "@/lib/services/company/get-content-mix.service";
import { updateContentMix } from "@/lib/services/company/update-content-mix.service";
import { contentMixSchema } from "@/lib/validators/content-mix.schema";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const session = await auth();
  if (!session)
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 }
    );

  const { slug } = await params;
  const result = await getContentMix(slug, session.user.id, session.user.isGlobalAdmin);

  if (!result.success) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "Not found" } },
      { status: 404 }
    );
  }
  return NextResponse.json({ mix: result.mix });
}

/**
 * Saves the entire distribution at once. PUT, not PATCH: quotas are only valid
 * as a set, so there is no coherent partial update (see content-mix.schema.ts).
 */
export async function PUT(req: Request, { params }: { params: Promise<{ slug: string }> }) {
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

  const parsed = contentMixSchema.safeParse(body);
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

  const result = await updateContentMix(
    slug,
    session.user.id,
    session.user.isGlobalAdmin,
    parsed.data
  );

  if (!result.success) {
    switch (result.code) {
      case "NOT_FOUND":
        return NextResponse.json(
          { error: { code: "NOT_FOUND", message: "Not found" } },
          { status: 404 }
        );
      case "FORBIDDEN":
        return NextResponse.json(
          { error: { code: "FORBIDDEN", message: "Forbidden" } },
          { status: 403 }
        );
      default:
        // Every remaining code is a rejected distribution — 422, with the
        // specific code so the UI can explain exactly which rule was broken.
        return NextResponse.json(
          { error: { code: result.code, message: result.message ?? "Invalid content mix" } },
          { status: 422 }
        );
    }
  }

  return NextResponse.json({ mix: result.mix });
}
