import { prisma } from "@/lib/db/client";
import { resolveCompetitiveAnalysisContext } from "./resolve-competitor-context";
import { defaultResearchTopicsFromBrand } from "./research-profile-versioning";

export interface ResearchProfileDTO {
  researchTopics: string[];
  markets: string[];
  analysisPeriodDays: 30 | 90 | 180;
  profileVersion: number;
  /** False when this is a computed default — no row has ever been saved for
   *  this company. The UI uses this to explain why Save will create the first
   *  row rather than update one. */
  persisted: boolean;
}

export type GetResearchProfileResult =
  | { success: true; profile: ResearchProfileDTO; isOwner: boolean }
  | { success: false; code: "NOT_FOUND" };

function normalizePeriod(days: number): 30 | 90 | 180 {
  return days === 30 || days === 180 ? days : 90;
}

/**
 * Read-without-write, per the approved plan (§3.2/§7): opening Competitive
 * Analysis must never create a `CompetitorResearchProfile` row. If one exists,
 * it is returned as-is. If not, this computes an UNPERSISTED default —
 * `researchTopics` from BrandGuidelines' top+medium priority topics (or `[]`
 * if Brand Guidelines has none), `markets: []`, `analysisPeriodDays: 90` — and
 * returns it without writing anything.
 */
export async function getResearchProfileOrDefaults(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<GetResearchProfileResult> {
  const resolved = await resolveCompetitiveAnalysisContext(slug, userId, isGlobalAdmin, false);
  if (!resolved.ok) return { success: false, code: "NOT_FOUND" };

  const { companyId, isOwner } = resolved.context;

  const existing = await prisma.competitorResearchProfile.findUnique({
    where: { companyId },
    select: {
      researchTopics: true,
      markets: true,
      analysisPeriodDays: true,
      profileVersion: true,
    },
  });

  if (existing) {
    return {
      success: true,
      isOwner,
      profile: {
        researchTopics: existing.researchTopics,
        markets: existing.markets,
        analysisPeriodDays: normalizePeriod(existing.analysisPeriodDays),
        profileVersion: existing.profileVersion,
        persisted: true,
      },
    };
  }

  const brand = await prisma.brandGuidelines.findUnique({
    where: { companyId },
    select: { topPriorityTopics: true, mediumPriorityTopics: true },
  });

  const researchTopics = defaultResearchTopicsFromBrand(brand);

  return {
    success: true,
    isOwner,
    profile: {
      researchTopics,
      markets: [],
      analysisPeriodDays: 90,
      profileVersion: 1,
      persisted: false,
    },
  };
}
