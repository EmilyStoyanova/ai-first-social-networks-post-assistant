import { z } from "zod";

const baseFields = {
  name: z.string().min(1, "Name is required.").max(200),
  enabled: z.boolean().optional(),
};

/** Content languages the app generates in; also the translation targets (v2-4). */
export const TRANSLATION_LANGUAGES = ["en", "bg"] as const;

const rssSchema = z.object({
  type: z.literal("rss"),
  ...baseFields,
  config: z.object({
    url: z.string().url("Must be a valid URL."),
    // Per-source source-link preference (v2-1). Omitted = inherit channel default.
    includeSourceLink: z.boolean().optional(),
    // Per-source translation (v2-4). Omitted = disabled; when enabled without a
    // target, the company's content language is used.
    translateEnabled: z.boolean().optional(),
    translateToLanguage: z.enum(TRANSLATION_LANGUAGES).optional(),
  }),
});

const promptSchema = z.object({
  type: z.literal("prompt"),
  ...baseFields,
  config: z.object({
    promptText: z.string().min(1, "Prompt text is required.").max(5000),
  }),
});

const productPageSchema = z.object({
  type: z.literal("product_page"),
  ...baseFields,
  config: z.object({ url: z.string().url("Must be a valid URL.") }),
});

const calendarEventSchema = z.object({
  type: z.literal("calendar_event"),
  ...baseFields,
  config: z.object({
    title: z.string().min(1, "Event title is required.").max(500),
    date: z.string().min(1, "Event date is required."),
    description: z.string().max(5000).optional(),
  }),
});

export const contentSourceSchema = z.discriminatedUnion("type", [
  rssSchema,
  promptSchema,
  productPageSchema,
  calendarEventSchema,
]);

export type ContentSourceInput = z.infer<typeof contentSourceSchema>;
