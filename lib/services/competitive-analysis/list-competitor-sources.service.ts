import { prisma } from "@/lib/db/client";
import { resolveCompetitiveAnalysisContext } from "./resolve-competitor-context";
import {
  COMPETITOR_SOURCE_SELECT,
  toCompetitorSourceItem,
  type CompetitorSourceItem,
} from "./competitor-source-dto";

export type ListCompetitorSourcesResult =
  { success: true; sources: CompetitorSourceItem[] } | { success: false; code: "NOT_FOUND" };

/** Any member (owner or editor) may view — mutation is owner-only (§2/§14). */
export async function listCompetitorSources(
  slug: string,
  competitorId: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<ListCompetitorSourcesResult> {
  const resolved = await resolveCompetitiveAnalysisContext(slug, userId, isGlobalAdmin, false);
  if (!resolved.ok) return { success: false, code: "NOT_FOUND" };
  const { companyId } = resolved.context;

  const rows = await prisma.contentSource.findMany({
    where: { competitorId, companyId, type: "competitor_rss" },
    orderBy: { createdAt: "asc" },
    select: COMPETITOR_SOURCE_SELECT,
  });

  return { success: true, sources: rows.map(toCompetitorSourceItem) };
}
