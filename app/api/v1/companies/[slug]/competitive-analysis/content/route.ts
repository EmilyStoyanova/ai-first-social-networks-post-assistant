import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  listCompetitorContent,
  type CompetitorContentFilters,
} from "@/lib/services/competitive-analysis/list-competitor-content.service";

const RELEVANCE_VALUES = new Set(["pending", "relevant", "related", "out_of_scope"]);
const ORIGIN_VALUES = new Set(["feed_item", "manual_entry"]);

function parseFilters(url: URL): CompetitorContentFilters {
  const params = url.searchParams;
  const competitorId = params.get("competitorId") ?? undefined;
  const originRaw = params.get("origin");
  const relevanceRaw = params.get("relevance");
  const status = params.get("status") ?? undefined;

  return {
    ...(competitorId ? { competitorId } : {}),
    ...(originRaw && ORIGIN_VALUES.has(originRaw)
      ? { origin: originRaw as CompetitorContentFilters["origin"] }
      : {}),
    ...(relevanceRaw && RELEVANCE_VALUES.has(relevanceRaw)
      ? { relevance: relevanceRaw as CompetitorContentFilters["relevance"] }
      : {}),
    ...(status ? { status } : {}),
  };
}

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const session = await auth();
  if (!session)
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 }
    );

  const { slug } = await params;
  const filters = parseFilters(new URL(req.url));

  const result = await listCompetitorContent(
    slug,
    session.user.id,
    session.user.isGlobalAdmin,
    filters
  );

  if (!result.success) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "Not found" } },
      { status: 404 }
    );
  }
  return NextResponse.json({ items: result.items });
}
