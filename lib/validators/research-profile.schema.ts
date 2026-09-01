import { z } from "zod";

/** The only three periods the Research Profile / Trends filter offer (§3.1). */
export const ANALYSIS_PERIOD_DAYS = [30, 90, 180] as const;

export const updateResearchProfileSchema = z.object({
  researchTopics: z.array(z.string().trim().min(1).max(200)).max(50),
  markets: z.array(z.string().trim().min(1).max(200)).max(50),
  analysisPeriodDays: z.union([z.literal(30), z.literal(90), z.literal(180)]),
});

export type UpdateResearchProfileInput = z.infer<typeof updateResearchProfileSchema>;
