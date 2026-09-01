import { prisma } from "@/lib/db/client";
import { createAuditLog, AUDIT_ACTIONS } from "@/lib/services/audit/audit-log.service";
import { resolveCompetitiveAnalysisContext } from "./resolve-competitor-context";
import { COMPETITOR_SELECT, toCompetitorItem, type CompetitorListItem } from "./competitor-dto";
import { toCompetitorSocialProfileCreateInput } from "./competitor-social-profiles-input";
import type { CompetitorInput } from "@/lib/validators/competitor.schema";

export type UpdateCompetitorResult =
  | { success: true; competitor: CompetitorListItem }
  | { success: false; code: "NOT_FOUND" | "FORBIDDEN" };

/**
 * Owner-only. `socialProfiles` is a whole-list replace, not a per-profile
 * diff — the form always submits the complete current list, so
 * delete-then-recreate inside one transaction is simpler than reconciling
 * adds/edits/removals. This DOES discard any collection-state columns a
 * future Part 3C sync had written on the deleted rows (lastCollectedAt,
 * externalProfileId, etc.) — acceptable in Part 3A because nothing ever
 * writes them yet, but Part 3C's own update path will need a real diff
 * instead of this delete-then-recreate once that state exists to lose.
 */
export async function updateCompetitor(
  slug: string,
  competitorId: string,
  userId: string,
  isGlobalAdmin: boolean,
  data: CompetitorInput
): Promise<UpdateCompetitorResult> {
  const resolved = await resolveCompetitiveAnalysisContext(slug, userId, isGlobalAdmin, true);
  if (!resolved.ok) return { success: false, code: resolved.code };

  const { companyId } = resolved.context;

  // Scoped to companyId so an id lifted from another company's URL cannot be
  // targeted — NOT_FOUND, not FORBIDDEN, so existence is never leaked either.
  const existing = await prisma.competitor.findFirst({
    where: { id: competitorId, companyId },
    select: { id: true },
  });
  if (!existing) return { success: false, code: "NOT_FOUND" };

  const profileInputs = toCompetitorSocialProfileCreateInput(data.socialProfiles);

  const row = await prisma.$transaction(async (tx) => {
    await tx.competitorSocialProfile.deleteMany({ where: { competitorId } });
    return tx.competitor.update({
      where: { id: competitorId },
      data: {
        name: data.name,
        country: data.country || null,
        website: data.website || null,
        notes: data.notes || null,
        socialProfiles: profileInputs.length > 0 ? { create: profileInputs } : undefined,
      },
      select: COMPETITOR_SELECT,
    });
  });

  await createAuditLog({
    companyId,
    userId,
    action: AUDIT_ACTIONS.COMPETITOR_UPDATED,
    entityType: "competitor",
    entityId: row.id,
    metadata: { name: row.name },
  });

  return { success: true, competitor: toCompetitorItem(row) };
}
