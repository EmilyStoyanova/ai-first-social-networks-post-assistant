import { z } from "zod";

const hexColor = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/, "Must be a valid hex color (#RRGGBB).")
  .optional();

export const updateBrandGuidelinesSchema = z.object({
  automationMode: z.enum(["semi_automated", "fully_automated"]).optional(),
  // Company-wide brand default post language (Company.defaultLang). Channels
  // inherit this unless they set their own override.
  defaultLang: z.enum(["en", "bg"]).optional(),
  logoUrl: z.string().url("Must be a valid URL.").optional(),
  primaryColor: hexColor,
  secondaryColor: hexColor,
  fontFamily: z.string().max(100, "Font family must be at most 100 characters.").optional(),
  toneOfVoice: z.string().max(200, "Tone of voice must be at most 200 characters.").optional(),
  companyDescription: z
    .string()
    .max(2000, "Company description must be at most 2000 characters.")
    .optional(),
  targetAudience: z
    .string()
    .max(1000, "Target audience must be at most 1000 characters.")
    .optional(),
  forbiddenWords: z.array(z.string()).optional(),
  competitors: z.array(z.string()).optional(),
});

export type UpdateBrandGuidelinesInput = z.infer<typeof updateBrandGuidelinesSchema>;
