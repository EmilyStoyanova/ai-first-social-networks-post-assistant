import { prisma } from "@/lib/db/client";
import { resolveCompetitiveAnalysisContext } from "./resolve-competitor-context";
import { COMPETITOR_SELECT, toCompetitorItem, type CompetitorListItem } from "./competitor-dto";
import { archivedWhereFragment, type CompetitorListFilter } from "./competitor-list-filter";

export type { CompetitorListFilter };

export type ListCompetitorsResult =
  | { success: true; competitors: CompetitorListItem[]; isOwner: boolean }
  | { success: false; code: "NOT_FOUND" };

/** Hard-scoped by company — every row returned belongs to `slug`'s company,
 *  never a caller-supplied id. `filter` defaults to "active": archived
 *  competitors are excluded from the default listing (§3.13). */
export async function listCompetitors(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean,
  filter: CompetitorListFilter = "active"
): Promise<ListCompetitorsResult> {
  const resolved = await resolveCompetitiveAnalysisContext(slug, userId, isGlobalAdmin, false);
  if (!resolved.ok) return { success: false, code: "NOT_FOUND" };

  const rows = await prisma.competitor.findMany({
    where: { companyId: resolved.context.companyId, ...archivedWhereFragment(filter) },
    orderBy: { createdAt: "desc" },
    select: COMPETITOR_SELECT,
  });

  return {
    success: true,
    competitors: rows.map(toCompetitorItem),
    isOwner: resolved.context.isOwner,
  };
}
