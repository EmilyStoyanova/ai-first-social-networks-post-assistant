import { prisma } from "@/lib/db/client";

export type DeleteContentSourceResult =
  { success: true } | { success: false; code: "NOT_FOUND" | "FORBIDDEN" };

export async function deleteContentSource(
  slug: string,
  sourceId: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<DeleteContentSourceResult> {
  let companyId: string;

  if (isGlobalAdmin) {
    const company = await prisma.company.findUnique({ where: { slug }, select: { id: true } });
    if (!company) return { success: false, code: "NOT_FOUND" };
    companyId = company.id;
  } else {
    const membership = await prisma.companyMember.findFirst({
      where: { company: { slug }, userId },
      select: { companyId: true, role: true },
    });
    if (!membership) return { success: false, code: "NOT_FOUND" };
    if (membership.role !== "owner") return { success: false, code: "FORBIDDEN" };
    companyId = membership.companyId;
  }

  const existing = await prisma.contentSource.findFirst({
    where: { id: sourceId, companyId },
    select: { id: true },
  });
  if (!existing) return { success: false, code: "NOT_FOUND" };

  await prisma.contentSource.delete({ where: { id: sourceId } });
  return { success: true };
}
