import { z } from "zod";

export const createCompanySchema = z.object({
  name: z
    .string()
    .min(2, "Name must be at least 2 characters.")
    .max(100, "Name must be at most 100 characters."),
  website: z
    .string()
    .url("Website must be a valid URL.")
    .max(255, "Website must be at most 255 characters.")
    .optional(),
});

export type CreateCompanyInput = z.infer<typeof createCompanySchema>;
