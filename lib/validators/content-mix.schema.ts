import { z } from "zod";
import { MAX_POSTS_PER_CHANNEL_PER_WEEK } from "@/lib/scheduling/content-mix";

/**
 * The whole distribution is submitted at once (v2-8).
 *
 * There is deliberately no per-source PATCH: quotas are only meaningful
 * together, and any single-field edit would have to pass through an invalid
 * total (3→2 breaks the sum before the compensating edit lands), so a per-field
 * endpoint could never be saved.
 *
 * `null` clears a quota — it means "this source takes no part in the mix", which
 * is different from 0 ("contribute nothing"). Clearing every quota returns the
 * company to the pre-v2-8 pooling behaviour.
 */
const quotaValue = z
  .number()
  .int("Posts per week must be a whole number.")
  .min(0, "Posts per week cannot be negative.")
  .max(MAX_POSTS_PER_CHANNEL_PER_WEEK, `At most ${MAX_POSTS_PER_CHANNEL_PER_WEEK} posts per week.`)
  .nullable();

export const contentMixSchema = z.object({
  sources: z
    .array(
      z.object({
        sourceId: z.string().min(1),
        postsPerWeek: quotaValue,
      })
    )
    .max(50),
  /** Weekly quota for mission/brand posts written without any RSS article. */
  companyContentPostsPerWeek: quotaValue,
});

export type ContentMixInput = z.infer<typeof contentMixSchema>;
