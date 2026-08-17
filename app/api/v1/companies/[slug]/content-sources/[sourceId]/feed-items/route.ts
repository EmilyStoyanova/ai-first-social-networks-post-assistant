import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { listFeedItems } from "@/lib/services/company/list-feed-items.service";
import { parseClassificationFilter } from "@/lib/posts/feed-item-classification-filter";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string; sourceId: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });

  const { slug, sourceId } = await params;
  // `?classification=high|medium|rejected|unclassified`. Anything unrecognised
  // falls back to "all" rather than erroring — a stale bookmark should show the
  // list, not a failure.
  const filter = parseClassificationFilter(new URL(req.url).searchParams.get("classification"));
  const result = await listFeedItems(
    slug,
    sourceId,
    session.user.id,
    session.user.isGlobalAdmin,
    filter
  );

  if (!result.success) {
    const status = result.code === "NOT_FOUND" ? 404 : 403;
    return NextResponse.json({ error: { code: result.code } }, { status });
  }
  return NextResponse.json({ items: result.items, counts: result.counts });
}
