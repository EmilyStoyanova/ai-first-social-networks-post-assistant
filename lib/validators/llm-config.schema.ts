import { z } from "zod";

export const createLlmConfigSchema = z.object({
  provider: z.enum(["CLAUDE", "OPENAI", "GROK"]),
  model: z.string().min(1, "Model is required."),
  apiKey: z.string().min(1, "API key is required."),
  isActive: z.boolean().default(false),
});

export const updateLlmConfigSchema = z.object({
  model: z.string().min(1, "Model cannot be empty.").optional(),
  apiKey: z.string().min(1, "API key cannot be empty.").optional(),
  isActive: z.boolean().optional(),
});

export type CreateLlmConfigInput = z.infer<typeof createLlmConfigSchema>;
export type UpdateLlmConfigInput = z.infer<typeof updateLlmConfigSchema>;
