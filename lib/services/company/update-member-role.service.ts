import { prisma } from "@/lib/db/client";
import { toMemberItem, type MemberItem } from "./list-members.service";
import type { UpdateMemberRoleInput } from "@/lib/validators/company-member.schema";

export type UpdateMemberRoleResult =
  | { success: true; member: MemberItem }
  | {
      success: false;
      code: "NOT_FOUND" | "FORBIDDEN" | "CANNOT_CHANGE_OWN_ROLE";
    };

const SELECT = {
  id: true,
  role: true,
  createdAt: true,
  user: { select: { name: true, email: true } },
} as const;

export async function updateMemberRole(
  slug: string,
  currentUserId: string,
  isGlobalAdmin: boolean,
  memberId: string,
  data: UpdateMemberRoleInput
): Promise<UpdateMemberRoleResult> {
  let companyId: string;

  if (isGlobalAdmin) {
    const company = await prisma.company.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (!company) return { success: false, code: "NOT_FOUND" };
    companyId = company.id;
  } else {
    const membership = await prisma.companyMember.findFirst({
      where: { userId: currentUserId, company: { slug } },
      select: { role: true, companyId: true },
    });
    if (!membership) return { success: false, code: "NOT_FOUND" };
    if (membership.role !== "owner") return { success: false, code: "FORBIDDEN" };
    companyId = membership.companyId;
  }

  const target = await prisma.companyMember.findFirst({
    where: { id: memberId, companyId },
    select: { id: true, userId: true },
  });
  if (!target) return { success: false, code: "NOT_FOUND" };
  if (target.userId === currentUserId) return { success: false, code: "CANNOT_CHANGE_OWN_ROLE" };

  const updated = await prisma.companyMember.update({
    where: { id: memberId },
    data: { role: data.role === "OWNER" ? "owner" : "editor" },
    select: SELECT,
  });

  return { success: true, member: toMemberItem(updated) };
}
