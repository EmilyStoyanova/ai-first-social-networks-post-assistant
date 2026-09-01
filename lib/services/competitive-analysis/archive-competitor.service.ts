import { prisma } from "@/lib/db/client";
import { createAuditLog, AUDIT_ACTIONS } from "@/lib/services/audit/audit-log.service";
import { resolveCompetitiveAnalysisContext } from "./resolve-competitor-context";
import { COMPETITOR_SELECT, toCompetitorItem, type CompetitorListItem } from "./competitor-dto";

export type ArchiveCompetitorResult =
  | { success: true; competitor: CompetitorListItem }
  | { success: false; code: "NOT_FOUND" | "FORBIDDEN" };

/**
 * Owner-only. Sets `archivedAt` — the competitor drops out of the default
 * listing; every row (links, sources, history) is retained untouched. Distinct
 * from `deleteCompetitor`, which is permanent — see that service.
 *
 * Idempotent: archiving an already-archived competitor just re-stamps the
 * timestamp rather than erroring, matching the enable/disable toggle
 * convention used elsewhere in this codebase (e.g. content sources).
 */
export async function archiveCompetitor(
  slug: string,
  competitorId: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<ArchiveCompetitorResult> {
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
    data: { archivedAt: new Date() },
    select: COMPETITOR_SELECT,
  });

  await createAuditLog({
    companyId,
    userId,
    action: AUDIT_ACTIONS.COMPETITOR_ARCHIVED,
    entityType: "competitor",
    entityId: row.id,
    metadata: { name: row.name },
  });

  return { success: true, competitor: toCompetitorItem(row) };
}
