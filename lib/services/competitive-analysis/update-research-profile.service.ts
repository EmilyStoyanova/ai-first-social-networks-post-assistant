import { prisma } from "@/lib/db/client";
import { createAuditLog, AUDIT_ACTIONS } from "@/lib/services/audit/audit-log.service";
import { resolveCompetitiveAnalysisContext } from "./resolve-competitor-context";
import { computeNextProfileVersion } from "./research-profile-versioning";
import type { UpdateResearchProfileInput } from "@/lib/validators/research-profile.schema";
import type { ResearchProfileDTO } from "./get-research-profile-or-defaults.service";

export type UpdateResearchProfileResult =
  | { success: true; profile: ResearchProfileDTO }
  | { success: false; code: "NOT_FOUND" | "FORBIDDEN" };

/**
 * Owner-only. The only writer of `CompetitorResearchProfile` — an upsert, so
 * the first Save creates the row and every Save after that updates it. From
 * that first Save on, the profile is independent of BrandGuidelines: later
 * Brand changes are never synced in (§3.2).
 *
 * `profileVersion` starts at 1 and increments ONLY when `researchTopics` or
 * `markets` actually changed (order-independent) — never for an
 * `analysisPeriodDays`-only save. This is versioning only: Part 3B's
 * relevance-recompute sweep (keyed off this number) is not implemented here.
 */
export async function updateResearchProfile(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean,
  data: UpdateResearchProfileInput
): Promise<UpdateResearchProfileResult> {
  const resolved = await resolveCompetitiveAnalysisContext(slug, userId, isGlobalAdmin, true);
  if (!resolved.ok) return { success: false, code: resolved.code };

  const { companyId } = resolved.context;

  const existing = await prisma.competitorResearchProfile.findUnique({
    where: { companyId },
    select: { researchTopics: true, markets: true, profileVersion: true },
  });

  const nextVersion = computeNextProfileVersion(existing, data);
  const versionBumped = existing !== null && nextVersion !== existing.profileVersion;

  const row = await prisma.competitorResearchProfile.upsert({
    where: { companyId },
    create: {
      companyId,
      researchTopics: data.researchTopics,
      markets: data.markets,
      analysisPeriodDays: data.analysisPeriodDays,
      profileVersion: nextVersion,
    },
    update: {
      researchTopics: data.researchTopics,
      markets: data.markets,
      analysisPeriodDays: data.analysisPeriodDays,
      profileVersion: nextVersion,
    },
    select: {
      researchTopics: true,
      markets: true,
      analysisPeriodDays: true,
      profileVersion: true,
    },
  });

  await createAuditLog({
    companyId,
    userId,
    action: AUDIT_ACTIONS.RESEARCH_PROFILE_UPDATED,
    entityType: "competitor_research_profile",
    metadata: { profileVersion: row.profileVersion, versionBumped },
  });

  return {
    success: true,
    profile: {
      researchTopics: row.researchTopics,
      markets: row.markets,
      analysisPeriodDays: row.analysisPeriodDays as 30 | 90 | 180,
      profileVersion: row.profileVersion,
      persisted: true,
    },
  };
}
