import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { restoreCompetitor } from "@/lib/services/competitive-analysis/restore-competitor.service";

export async function POST(
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
  const result = await restoreCompetitor(
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
  return NextResponse.json({ competitor: result.competitor });
}
