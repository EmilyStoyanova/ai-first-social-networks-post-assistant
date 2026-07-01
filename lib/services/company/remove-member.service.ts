import { prisma } from "@/lib/db/client";

export type RemoveMemberResult =
  | { success: true }
  | {
      success: false;
      code: "NOT_FOUND" | "FORBIDDEN" | "CANNOT_REMOVE_SELF" | "CANNOT_REMOVE_LAST_OWNER";
    };

export async function removeMember(
  slug: string,
  currentUserId: string,
  isGlobalAdmin: boolean,
  memberId: string
): Promise<RemoveMemberResult> {
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
    select: { id: true, userId: true, role: true },
  });
  if (!target) return { success: false, code: "NOT_FOUND" };
  if (target.userId === currentUserId) return { success: false, code: "CANNOT_REMOVE_SELF" };

  if (target.role === "owner") {
    const ownerCount = await prisma.companyMember.count({
      where: { companyId, role: "owner" },
    });
    if (ownerCount <= 1) return { success: false, code: "CANNOT_REMOVE_LAST_OWNER" };
  }

  await prisma.companyMember.delete({ where: { id: memberId } });

  return { success: true };
}
