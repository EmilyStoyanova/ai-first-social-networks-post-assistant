import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { listFeedItems } from "@/lib/services/company/list-feed-items.service";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string; sourceId: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });

  const { slug, sourceId } = await params;
  const result = await listFeedItems(slug, sourceId, session.user.id, session.user.isGlobalAdmin);

  if (!result.success) {
    const status = result.code === "NOT_FOUND" ? 404 : 403;
    return NextResponse.json({ error: { code: result.code } }, { status });
  }
  return NextResponse.json({ items: result.items });
}
