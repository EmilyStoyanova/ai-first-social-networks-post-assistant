import { prisma } from "@/lib/db/client";

export interface ResolvedCompetitor {
  id: string;
  companyId: string;
  archivedAt: Date | null;
}

/**
 * Verifies `competitorId` actually belongs to `companyId` before any
 * competitor-scoped mutation touches it — the same hard-scoping rule every
 * Part 3A competitor service already applies inline; factored out here so
 * every Part 3B service (sources, manual entries, ingestion) shares one
 * definition. Returns `null` for a competitor that does not exist OR belongs
 * to a different company — the caller reports both as NOT_FOUND, never
 * FORBIDDEN, so a competitor id lifted from another company's URL cannot be
 * used to distinguish "wrong company" from "does not exist" (mirrors
 * `resolveCompetitiveAnalysisContext`'s own reasoning).
 */
export async function resolveCompetitorInCompany(
  competitorId: string,
  companyId: string
): Promise<ResolvedCompetitor | null> {
  return prisma.competitor.findFirst({
    where: { id: competitorId, companyId },
    select: { id: true, companyId: true, archivedAt: true },
  });
}
