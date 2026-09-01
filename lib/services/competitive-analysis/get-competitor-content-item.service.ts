import { prisma } from "@/lib/db/client";
import { resolveCompetitiveAnalysisContext } from "./resolve-competitor-context";
import {
  COMPETITOR_CONTENT_SELECT,
  toCompetitorContentDetail,
  type CompetitorContentDetail,
} from "./competitor-content-dto";

export type GetCompetitorContentItemResult =
  { success: true; item: CompetitorContentDetail } | { success: false; code: "NOT_FOUND" };

/** Any member may view. Hard company-scoped: an intelligenceId from another
 *  company's URL resolves NOT_FOUND, never a cross-company read. */
export async function getCompetitorContentItem(
  slug: string,
  intelligenceId: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<GetCompetitorContentItemResult> {
  const resolved = await resolveCompetitiveAnalysisContext(slug, userId, isGlobalAdmin, false);
  if (!resolved.ok) return { success: false, code: "NOT_FOUND" };
  const { companyId } = resolved.context;

  const row = await prisma.competitorIntelligence.findFirst({
    where: { id: intelligenceId, companyId },
    select: COMPETITOR_CONTENT_SELECT,
  });
  if (!row) return { success: false, code: "NOT_FOUND" };

  return { success: true, item: toCompetitorContentDetail(row) };
}
