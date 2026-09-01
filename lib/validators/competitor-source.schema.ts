import { z } from "zod";

/**
 * A competitor's labeled RSS feed (Part 3B §2). Deliberately a much smaller
 * schema than `content-source.schema.ts`'s `rssSchema`: no
 * translate/classify/source-link config, because a competitor item never
 * enters those pipelines (§4/§8) — there is nothing for those fields to
 * configure.
 */
export const competitorSourceSchema = z.object({
  label: z.string().trim().min(1, "Label is required.").max(200),
  url: z.string().trim().url("Must be a valid URL.").max(2000),
  enabled: z.boolean().optional(),
});

export type CompetitorSourceInput = z.infer<typeof competitorSourceSchema>;
