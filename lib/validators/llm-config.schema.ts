import { z } from "zod";

/**
 * Admin runtime-state toggle for a supported provider. Credentials are never
 * accepted here — availability comes from environment variables only. At least
 * one flag must be present.
 */
export const setLlmProviderStateSchema = z
  .object({
    isActive: z.boolean().optional(),
    isDefault: z.boolean().optional(),
  })
  .refine((d) => d.isActive !== undefined || d.isDefault !== undefined, {
    message: "Provide isActive and/or isDefault.",
  });

export type SetLlmProviderStateInput = z.infer<typeof setLlmProviderStateSchema>;
