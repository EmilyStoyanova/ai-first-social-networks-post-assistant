import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCompetitorContentItem } from "@/lib/services/competitive-analysis/get-competitor-content-item.service";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string; intelligenceId: string }> }
) {
  const session = await auth();
  if (!session)
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 }
    );

  const { slug, intelligenceId } = await params;
  const result = await getCompetitorContentItem(
    slug,
    intelligenceId,
    session.user.id,
    session.user.isGlobalAdmin
  );

  if (!result.success) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "Not found" } },
      { status: 404 }
    );
  }
  return NextResponse.json({ item: result.item });
}
