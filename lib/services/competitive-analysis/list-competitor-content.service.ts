import { prisma } from "@/lib/db/client";
import { resolveCompetitiveAnalysisContext } from "./resolve-competitor-context";
import {
  COMPETITOR_CONTENT_SELECT,
  toCompetitorContentItem,
  type CompetitorContentItem,
  type CompetitorContentOrigin,
} from "./competitor-content-dto";

export interface CompetitorContentFilters {
  competitorId?: string;
  origin?: CompetitorContentOrigin;
  relevance?: "pending" | "relevant" | "related" | "out_of_scope";
  /** The extraction pipeline's status — pending | analyzing | completed | failed. */
  status?: string;
}

export type ListCompetitorContentResult =
  { success: true; items: CompetitorContentItem[] } | { success: false; code: "NOT_FOUND" };

/** Any member (owner or editor) may view (§3.14/§16). Newest-observed first;
 *  capped at 200 rows — Trends (Part 3E) owns aggregation, this is a
 *  browsable list, not an export. */
export async function listCompetitorContent(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean,
  filters: CompetitorContentFilters = {}
): Promise<ListCompetitorContentResult> {
  const resolved = await resolveCompetitiveAnalysisContext(slug, userId, isGlobalAdmin, false);
  if (!resolved.ok) return { success: false, code: "NOT_FOUND" };
  const { companyId } = resolved.context;

  const rows = await prisma.competitorIntelligence.findMany({
    where: {
      companyId,
      ...(filters.competitorId ? { competitorId: filters.competitorId } : {}),
      ...(filters.relevance ? { relevance: filters.relevance } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.origin === "feed_item" ? { feedItemId: { not: null } } : {}),
      ...(filters.origin === "manual_entry" ? { manualEntryId: { not: null } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: COMPETITOR_CONTENT_SELECT,
  });

  return { success: true, items: rows.map(toCompetitorContentItem) };
}
