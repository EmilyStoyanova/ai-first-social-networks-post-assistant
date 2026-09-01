import type { CompetitorSocialProfileInput } from "@/lib/validators/competitor.schema";

export interface CompetitorSocialProfileCreateInput {
  platform: CompetitorSocialProfileInput["platform"];
  url: string;
  label: string | null;
}

/**
 * Maps validated social-profile input to Prisma's nested `create` shape.
 * Pure — deliberately performs NO dedupe by platform: a competitor may have
 * several profiles on the same platform (§3.4/§1 of the social-analysis
 * correction — e.g. two regional Facebook pages), so every entry the caller
 * submitted is passed straight through. Every collection-state column is
 * intentionally omitted here — it always takes its schema default
 * (disabled/reference_only); Part 3A writes nothing to it.
 */
export function toCompetitorSocialProfileCreateInput(
  profiles: CompetitorSocialProfileInput[] | undefined
): CompetitorSocialProfileCreateInput[] {
  if (!profiles || profiles.length === 0) return [];
  return profiles.map((p) => ({
    platform: p.platform,
    url: p.url,
    label: p.label || null,
  }));
}
