import { prisma } from "@/lib/db/client";
import { createAuditLog, AUDIT_ACTIONS } from "@/lib/services/audit/audit-log.service";
import { resolveCompetitiveAnalysisContext } from "./resolve-competitor-context";
import { COMPETITOR_SELECT, toCompetitorItem, type CompetitorListItem } from "./competitor-dto";
import { toCompetitorSocialProfileCreateInput } from "./competitor-social-profiles-input";
import type { CompetitorInput } from "@/lib/validators/competitor.schema";

export type CreateCompetitorResult =
  | { success: true; competitor: CompetitorListItem }
  | { success: false; code: "NOT_FOUND" | "FORBIDDEN" };

/** Owner-only (editors may view but not mutate — §3.14). `companyId` and
 *  `createdBy` are never taken from the request body; both are derived here
 *  from the resolved, authenticated context. */
export async function createCompetitor(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean,
  data: CompetitorInput
): Promise<CreateCompetitorResult> {
  const resolved = await resolveCompetitiveAnalysisContext(slug, userId, isGlobalAdmin, true);
  if (!resolved.ok) return { success: false, code: resolved.code };

  const { companyId } = resolved.context;
  const profileInputs = toCompetitorSocialProfileCreateInput(data.socialProfiles);

  const row = await prisma.competitor.create({
    data: {
      companyId,
      name: data.name,
      country: data.country || null,
      website: data.website || null,
      notes: data.notes || null,
      createdBy: userId,
      socialProfiles: profileInputs.length > 0 ? { create: profileInputs } : undefined,
    },
    select: COMPETITOR_SELECT,
  });

  await createAuditLog({
    companyId,
    userId,
    action: AUDIT_ACTIONS.COMPETITOR_ADDED,
    entityType: "competitor",
    entityId: row.id,
    metadata: { name: row.name },
  });

  return { success: true, competitor: toCompetitorItem(row) };
}
