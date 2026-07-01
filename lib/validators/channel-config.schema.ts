import { z } from "zod";

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

export const upsertChannelConfigSchema = z.object({
  enabled: z.boolean(),
  bufferProfileId: z.string().max(256).nullable().optional(),
  postsPerDay: z.number().int().min(0).max(20),
  postsPerWeek: z.number().int().min(0).max(100),
  language: z.enum(["en", "bg"]),
  imageRequired: z.boolean(),
  automationModeOverride: z.enum(["semi_automated", "fully_automated"]).nullable().optional(),
  postingWindows: z.array(postingWindowSchema).optional(),
});

export type UpsertChannelConfigInput = z.infer<typeof upsertChannelConfigSchema>;
