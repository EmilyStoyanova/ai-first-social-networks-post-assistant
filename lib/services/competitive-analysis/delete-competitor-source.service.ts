import { prisma } from "@/lib/db/client";
import { createAuditLog, AUDIT_ACTIONS } from "@/lib/services/audit/audit-log.service";
import { resolveCompetitiveAnalysisContext } from "./resolve-competitor-context";

export type DeleteCompetitorSourceResult =
  { success: true } | { success: false; code: "NOT_FOUND" | "FORBIDDEN" };

/**
 * PERMANENT delete of a competitor RSS feed — a separate, explicit action from
 * disabling it (mirrors `delete-competitor.service.ts`'s own archive-vs-delete
 * split). Cascades to every `FeedItem`/`CompetitorIntelligence` collected
 * through it (`ContentSource` → `FeedItem` → `CompetitorIntelligence` are all
 * `onDelete: Cascade`). Owner-only.
 */
export async function deleteCompetitorSource(
  slug: string,
  competitorId: string,
  sourceId: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<DeleteCompetitorSourceResult> {
  const resolved = await resolveCompetitiveAnalysisContext(slug, userId, isGlobalAdmin, true);
  if (!resolved.ok) return { success: false, code: resolved.code };
  const { companyId } = resolved.context;

  const existing = await prisma.contentSource.findFirst({
    where: { id: sourceId, competitorId, companyId, type: "competitor_rss" },
    select: { id: true, name: true },
  });
  if (!existing) return { success: false, code: "NOT_FOUND" };

  await prisma.contentSource.delete({ where: { id: sourceId } });

  await createAuditLog({
    companyId,
    userId,
    action: AUDIT_ACTIONS.COMPETITOR_SOURCE_DELETED,
    entityType: "competitor_source",
    entityId: sourceId,
    metadata: { competitorId, label: existing.name },
  });

  return { success: true };
}
