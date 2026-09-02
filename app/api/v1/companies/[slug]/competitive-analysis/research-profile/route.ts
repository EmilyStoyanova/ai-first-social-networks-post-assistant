import { NextResponse } from "next/server";
import { getLocale } from "next-intl/server";
import { auth } from "@/lib/auth";
import { getResearchProfileOrDefaults } from "@/lib/services/competitive-analysis/get-research-profile-or-defaults.service";
import { updateResearchProfile } from "@/lib/services/competitive-analysis/update-research-profile.service";
import { updateResearchProfileSchema } from "@/lib/validators/research-profile.schema";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const session = await auth();
  if (!session)
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 }
    );

  const { slug } = await params;
  // The current application locale (NEXT_LOCALE) seeds an UNPERSISTED
  // profile's `analysisLanguage` default (2026-09-02 ownership-boundary fix)
  // — deliberately not Company.defaultLang. Has no effect once a profile is
  // saved. See get-research-profile-or-defaults.service.ts.
  const appLocale = await getLocale();
  const result = await getResearchProfileOrDefaults(
    slug,
    session.user.id,
    session.user.isGlobalAdmin,
    appLocale
  );

  if (!result.success) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "Not found" } },
      { status: 404 }
    );
  }
  return NextResponse.json({ profile: result.profile, isOwner: result.isOwner });
}

// Whole-profile PUT, never PATCH — a partial write cannot be validated against
// the versioning rule (§3.8 of the content-mix precedent this mirrors).
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

  const parsed = updateResearchProfileSchema.safeParse(body);
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

  const result = await updateResearchProfile(
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
  return NextResponse.json({ profile: result.profile });
}
