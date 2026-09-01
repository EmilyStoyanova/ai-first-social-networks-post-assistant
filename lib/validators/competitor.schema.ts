import { z } from "zod";

/** Mirrors the `CompetitorSocialPlatform` enum in schema.prisma. */
export const COMPETITOR_SOCIAL_PLATFORMS = [
  "facebook",
  "instagram",
  "linkedin",
  "tiktok",
  "youtube",
  "x",
  "other",
] as const;

/**
 * A profile URL. Part 3A never fetches it — no code path exists that could —
 * but the field itself is not permanently reference-only: it is what a future
 * collector (Part 3C) resolves an `externalProfileId` from. Scheme is checked
 * rather than just shape, same reasoning as `publicHttpUrl` in
 * content-source.schema.ts.
 */
const profileUrl = z
  .string()
  .trim()
  .min(1, "URL is required.")
  .max(2000)
  .refine((v) => /^https?:\/\//i.test(v), "Must start with http:// or https://");

const optionalProfileUrl = z
  .string()
  .trim()
  .max(2000)
  .optional()
  .refine((v) => !v || /^https?:\/\//i.test(v), "Must start with http:// or https://");

export const competitorSocialProfileSchema = z.object({
  /** Present when editing an existing profile; absent for a new one. */
  id: z.string().optional(),
  platform: z.enum(COMPETITOR_SOCIAL_PLATFORMS),
  url: profileUrl,
  label: z.string().trim().max(200).optional(),
});

export const competitorSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(200),
  country: z.string().trim().max(200).optional(),
  website: optionalProfileUrl,
  notes: z.string().trim().max(5000).optional(),
  // A competitor may have several social profiles on the same platform — no
  // uniqueness constraint here (§3.4/§1 of the social-analysis correction).
  // Whole-list replace on update, same shape a new competitor's initial list
  // already has. Part 3A never writes any of the collection-state columns —
  // they always take their schema defaults (disabled/reference_only).
  socialProfiles: z.array(competitorSocialProfileSchema).max(50).optional(),
});

export type CompetitorInput = z.infer<typeof competitorSchema>;
export type CompetitorSocialProfileInput = z.infer<typeof competitorSocialProfileSchema>;
