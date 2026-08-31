import { z } from "zod";
import { postingDaysCoverTarget } from "@/lib/scheduling/posting-windows";

const DAYS = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
] as const;

const HH_MM = z.string().regex(/^\d{2}:\d{2}$/, "Must be in HH:mm format.");

const postingWindowSchema = z
  .object({
    day: z.enum(DAYS),
    start: HH_MM,
    end: HH_MM,
  })
  .refine(({ start, end }) => start < end, {
    message: "Start time must be before end time.",
  });

/**
 * The stable name of the cross-field rule below, carried as the issue's message
 * so the route can answer with its own error code instead of a generic 400.
 *
 * A sentinel rather than prose: the user-facing wording lives in the UI, in both
 * locales, where it can name the actual numbers.
 */
export const INSUFFICIENT_POSTING_DAYS = "INSUFFICIENT_POSTING_DAYS";

export const upsertChannelConfigSchema = z
  .object({
    enabled: z.boolean(),
    postsPerDay: z.number().int().min(0).max(20),
    postsPerWeek: z.number().int().min(0).max(100),
    // "inherit" = use the company brand default (stored as NULL); "en"/"bg" set an
    // explicit per-channel override.
    language: z.enum(["inherit", "en", "bg"]),
    imageRequired: z.boolean(),
    includeSourceLink: z.boolean().optional().default(false),
    autoGenerateImage: z.boolean().optional().default(false),
    automationModeOverride: z.enum(["semi_automated", "fully_automated"]).nullable().optional(),
    postingWindows: z.array(postingWindowSchema).optional(),
  })
  // The weekly target and the posting days are only meaningful together:
  // automatic scheduling places at most one post per calendar day, so asking for
  // five posts a week with a single Friday window is a request that cannot be
  // honoured. It used to save, and the cron then placed four of those posts on
  // days nobody had configured. See postingDaysCoverTarget for why a channel
  // with NO windows is exempt rather than refused.
  .refine(
    ({ postsPerWeek, postingWindows }) => postingDaysCoverTarget(postsPerWeek, postingWindows),
    {
      message: INSUFFICIENT_POSTING_DAYS,
      path: ["postingWindows"],
    }
  );

export type UpsertChannelConfigInput = z.infer<typeof upsertChannelConfigSchema>;

/** Whether a rejected channel edit was rejected by the posting-day rule above. */
export function isInsufficientPostingDays(error: z.ZodError | undefined): boolean {
  return error?.issues.some((issue) => issue.message === INSUFFICIENT_POSTING_DAYS) ?? false;
}
