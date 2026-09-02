import { z } from "zod";
import { ANALYSIS_LANGUAGES } from "@/lib/i18n/analysis-language";

/** The only three periods the Research Profile / Trends filter offer (§3.1). */
export const ANALYSIS_PERIOD_DAYS = [30, 90, 180] as const;

export const updateResearchProfileSchema = z.object({
  researchTopics: z.array(z.string().trim().min(1).max(200)).max(50),
  markets: z.array(z.string().trim().min(1).max(200)).max(50),
  analysisPeriodDays: z.union([z.literal(30), z.literal(90), z.literal(180)]),
  // 2026-09-02 ownership-boundary fix — Competitive Analysis's own analysis
  // language, independent of Brand's `defaultLang`. Pinned to the same `en |
  // bg` vocabulary `resolveAnalysisLanguage` normalizes at read time.
  analysisLanguage: z.enum(ANALYSIS_LANGUAGES),
});

export type UpdateResearchProfileInput = z.infer<typeof updateResearchProfileSchema>;
