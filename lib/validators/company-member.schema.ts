import { z } from "zod";

export const inviteMemberSchema = z.object({
  email: z.string().email("Must be a valid email address."),
  role: z.enum(["OWNER", "EDITOR"]),
});

export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const updateMemberRoleSchema = z.object({
  role: z.enum(["OWNER", "EDITOR"], { message: "Role must be OWNER or EDITOR." }),
});

export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;
