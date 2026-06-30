import { z } from "zod";

export const credentialsSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

export type CredentialsInput = z.infer<typeof credentialsSchema>;
