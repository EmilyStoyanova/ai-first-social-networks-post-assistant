import { prisma } from "@/lib/db/client";
import { toMemberItem, type MemberItem } from "./list-members.service";
import type { InviteMemberInput } from "@/lib/validators/company-member.schema";

export type InviteMemberResult =
  | { success: true; member: MemberItem }
  | { success: false; code: "NOT_FOUND" | "FORBIDDEN" | "USER_NOT_FOUND" | "ALREADY_MEMBER" };

const SELECT = {
  id: true,
  role: true,
  createdAt: true,
  user: { select: { name: true, email: true } },
} as const;

export async function inviteMember(
  slug: string,
  currentUserId: string,
  isGlobalAdmin: boolean,
  data: InviteMemberInput
): Promise<InviteMemberResult> {
  let companyId: string;

  if (isGlobalAdmin) {
    const company = await prisma.company.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (!company) return { success: false, code: "NOT_FOUND" };
    companyId = company.id;
  } else {
    // Returning null for both "not found" and "not a member" avoids leaking
    // whether the company exists to users who aren't members.
    const membership = await prisma.companyMember.findFirst({
      where: { userId: currentUserId, company: { slug } },
      select: { role: true, companyId: true },
    });
    if (!membership) return { success: false, code: "NOT_FOUND" };
    if (membership.role !== "owner") return { success: false, code: "FORBIDDEN" };
    companyId = membership.companyId;
  }

  // Invited user must already have an account.
  const invitedUser = await prisma.user.findUnique({
    where: { email: data.email.trim().toLowerCase() },
    select: { id: true },
  });
  if (!invitedUser) return { success: false, code: "USER_NOT_FOUND" };

  // Guard duplicates — also covers the case where an owner/admin invites themselves.
  const existing = await prisma.companyMember.findFirst({
    where: { companyId, userId: invitedUser.id },
    select: { id: true },
  });
  if (existing) return { success: false, code: "ALREADY_MEMBER" };

  const created = await prisma.companyMember.create({
    data: {
      companyId,
      userId: invitedUser.id,
      role: data.role === "OWNER" ? "owner" : "editor",
      invitedBy: currentUserId,
    },
    select: SELECT,
  });

  return { success: true, member: toMemberItem(created) };
}
