import { prisma } from "@/lib/db/client";
import { createAuditLog, AUDIT_ACTIONS } from "@/lib/services/audit/audit-log.service";
import { resolveCompetitiveAnalysisContext } from "./resolve-competitor-context";
import {
  COMPETITOR_SOURCE_SELECT,
  toCompetitorSourceItem,
  type CompetitorSourceItem,
} from "./competitor-source-dto";
import type { CompetitorSourceInput } from "@/lib/validators/competitor-source.schema";

export type UpdateCompetitorSourceResult =
  | { success: true; source: CompetitorSourceItem }
  | { success: false; code: "NOT_FOUND" | "FORBIDDEN" };

/**
 * Updates a competitor RSS feed's label/URL, or toggles it enabled/disabled
 * (Part 3B §2). Owner-only. Disabling stops future ingestion but keeps every
 * `FeedItem`/`CompetitorIntelligence` already collected — "source history
 * should not be silently lost" — so this never deletes anything; see
 * `delete-competitor-source.service.ts` for the separate, explicit hard
 * delete.
 */
export async function updateCompetitorSource(
  slug: string,
  competitorId: string,
  sourceId: string,
  userId: string,
  isGlobalAdmin: boolean,
  data: CompetitorSourceInput
): Promise<UpdateCompetitorSourceResult> {
  const resolved = await resolveCompetitiveAnalysisContext(slug, userId, isGlobalAdmin, true);
  if (!resolved.ok) return { success: false, code: resolved.code };
  const { companyId } = resolved.context;

  const existing = await prisma.contentSource.findFirst({
    where: { id: sourceId, competitorId, companyId, type: "competitor_rss" },
    select: { enabled: true },
  });
  if (!existing) return { success: false, code: "NOT_FOUND" };

  const row = await prisma.contentSource.update({
    where: { id: sourceId },
    data: {
      name: data.label,
      config: { url: data.url },
      enabled: data.enabled ?? existing.enabled,
    },
    select: COMPETITOR_SOURCE_SELECT,
  });

  await createAuditLog({
    companyId,
    userId,
    action: AUDIT_ACTIONS.COMPETITOR_SOURCE_UPDATED,
    entityType: "competitor_source",
    entityId: row.id,
    metadata: { competitorId, label: row.name, enabled: row.enabled },
  });

  return { success: true, source: toCompetitorSourceItem(row) };
}
