import { prisma } from "@/lib/db/client";
import { createAuditLog, AUDIT_ACTIONS } from "@/lib/services/audit/audit-log.service";
import { resolveCompetitiveAnalysisContext } from "./resolve-competitor-context";

export type DeleteCompetitorResult =
  { success: true } | { success: false; code: "NOT_FOUND" | "FORBIDDEN" };

/**
 * Owner-only PERMANENT delete — a separate, explicit destructive action from
 * `archiveCompetitor`, never a fallback for it (§3.13/§11). Cascades per the
 * schema: links, content sources (and their feed items), manual entries, and
 * intelligence rows all cascade-delete with the competitor.
 */
export async function deleteCompetitor(
  slug: string,
  competitorId: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<DeleteCompetitorResult> {
  const resolved = await resolveCompetitiveAnalysisContext(slug, userId, isGlobalAdmin, true);
  if (!resolved.ok) return { success: false, code: resolved.code };

  const { companyId } = resolved.context;

  const existing = await prisma.competitor.findFirst({
    where: { id: competitorId, companyId },
    select: { id: true, name: true },
  });
  if (!existing) return { success: false, code: "NOT_FOUND" };

  await prisma.competitor.delete({ where: { id: competitorId } });

  await createAuditLog({
    companyId,
    userId,
    action: AUDIT_ACTIONS.COMPETITOR_DELETED,
    entityType: "competitor",
    entityId: existing.id,
    metadata: { name: existing.name },
  });

  return { success: true };
}
