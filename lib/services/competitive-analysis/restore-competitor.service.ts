import { prisma } from "@/lib/db/client";
import { createAuditLog, AUDIT_ACTIONS } from "@/lib/services/audit/audit-log.service";
import { resolveCompetitiveAnalysisContext } from "./resolve-competitor-context";
import { COMPETITOR_SELECT, toCompetitorItem, type CompetitorListItem } from "./competitor-dto";

export type RestoreCompetitorResult =
  | { success: true; competitor: CompetitorListItem }
  | { success: false; code: "NOT_FOUND" | "FORBIDDEN" };

/**
 * Owner-only. Clears `archivedAt` — the competitor returns to the active/
 * default listing. Part 3A has no queued work to resume (no ingestion exists
 * yet); a future Part 3B sweep resuming scheduled work is out of scope here.
 */
export async function restoreCompetitor(
  slug: string,
  competitorId: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<RestoreCompetitorResult> {
  const resolved = await resolveCompetitiveAnalysisContext(slug, userId, isGlobalAdmin, true);
  if (!resolved.ok) return { success: false, code: resolved.code };

  const { companyId } = resolved.context;

  const existing = await prisma.competitor.findFirst({
    where: { id: competitorId, companyId },
    select: { id: true },
  });
  if (!existing) return { success: false, code: "NOT_FOUND" };

  const row = await prisma.competitor.update({
    where: { id: competitorId },
    data: { archivedAt: null },
    select: COMPETITOR_SELECT,
  });

  await createAuditLog({
    companyId,
    userId,
    action: AUDIT_ACTIONS.COMPETITOR_RESTORED,
    entityType: "competitor",
    entityId: row.id,
    metadata: { name: row.name },
  });

  return { success: true, competitor: toCompetitorItem(row) };
}
