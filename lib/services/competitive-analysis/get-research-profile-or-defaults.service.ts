import { prisma } from "@/lib/db/client";
import { resolveCompetitiveAnalysisContext } from "./resolve-competitor-context";
import { defaultResearchTopicsFromBrand } from "./research-profile-versioning";
import { resolveAnalysisLanguage, type AnalysisLanguage } from "@/lib/i18n/analysis-language";

export interface ResearchProfileDTO {
  researchTopics: string[];
  markets: string[];
  analysisPeriodDays: 30 | 90 | 180;
  profileVersion: number;
  /** Competitive Analysis's own analysis language (2026-09-02
   *  ownership-boundary fix) — independent of `Company.defaultLang`. Always a
   *  normalized `en | bg` value, whether read from a persisted row or computed
   *  as an unpersisted default. */
  analysisLanguage: AnalysisLanguage;
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
 *
 * `appLocale` (2026-09-02 ownership-boundary fix) is the CURRENT application
 * locale — the caller's `next-intl` `getLocale()`, i.e. the viewer's
 * `NEXT_LOCALE` cookie, exactly like `LanguageSwitcher.tsx` writes and
 * `i18n/request.ts` reads. It is used ONLY to seed `analysisLanguage`'s
 * unpersisted default, and ONLY for a company with no saved profile — once a
 * profile is saved, its `analysisLanguage` lives entirely in the database and
 * this parameter no longer has any effect for that company. Deliberately NOT
 * `Company.defaultLang`: the whole point of this fix is that Competitive
 * Analysis must not reach into Brand for anything, including its default.
 */
export async function getResearchProfileOrDefaults(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean,
  appLocale?: string
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
      analysisLanguage: true,
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
        analysisLanguage: resolveAnalysisLanguage(existing.analysisLanguage),
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
      // Current application locale if it's one of the two supported analysis
      // languages, otherwise the safe application default — never Company.
      // defaultLang (§3 of the ownership-boundary fix).
      analysisLanguage: resolveAnalysisLanguage(appLocale),
      persisted: false,
    },
  };
}
