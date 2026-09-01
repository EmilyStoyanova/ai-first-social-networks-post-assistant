import { z } from "zod";

/** Mirrors `CompetitorManualEntry.sourceType` (a plain string column, not an
 *  enum — see the model comment in schema.prisma). */
export const COMPETITOR_MANUAL_SOURCE_TYPES = [
  "facebook",
  "instagram",
  "linkedin",
  "tiktok",
  "youtube",
  "x",
  "website",
  "other",
] as const;

export const COMPETITOR_MANUAL_POST_TYPES = ["organic", "ad"] as const;

/**
 * Manual competitor content import (Part 3B §5/§6). `url` is reference
 * metadata ONLY — never fetched by any code path (§21/§25.9). `capturedAt` is
 * optional and left unset when the person does not know it; it must NEVER be
 * backfilled from `createdAt` (§6) — that substitution happens nowhere in this
 * schema or its consuming services, on purpose.
 */
export const competitorManualEntrySchema = z.object({
  sourceType: z.enum(COMPETITOR_MANUAL_SOURCE_TYPES),
  postType: z.enum(COMPETITOR_MANUAL_POST_TYPES),
  url: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .refine((v) => !v || /^https?:\/\//i.test(v), "Must start with http:// or https://"),
  content: z.string().trim().min(1, "Content is required.").max(10000),
  /** ISO date/datetime string, e.g. from a `<input type=date>`. Absent =
   *  unknown — never defaulted to "now" by this schema or any caller. */
  capturedAt: z.string().trim().min(1).optional(),
});

export type CompetitorManualEntryInput = z.infer<typeof competitorManualEntrySchema>;
