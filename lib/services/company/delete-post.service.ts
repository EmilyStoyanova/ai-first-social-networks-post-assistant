import { prisma } from "@/lib/db/client";

export type DeletePostResult =
  { success: true } | { success: false; code: "NOT_FOUND" | "FORBIDDEN" };

export async function deletePost(
  slug: string,
  postId: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<DeletePostResult> {
  let companyId: string;
  let canDelete: boolean;

  if (isGlobalAdmin) {
    const company = await prisma.company.findUnique({ where: { slug }, select: { id: true } });
    if (!company) return { success: false, code: "NOT_FOUND" };
    companyId = company.id;
    canDelete = true;
  } else {
    const membership = await prisma.companyMember.findFirst({
      where: { company: { slug }, userId },
      select: { companyId: true, role: true },
    });
    if (!membership) return { success: false, code: "NOT_FOUND" };
    companyId = membership.companyId;
    canDelete = membership.role === "owner";
  }

  if (!canDelete) return { success: false, code: "FORBIDDEN" };

  const post = await prisma.post.findFirst({
    where: { id: postId, companyId },
    select: { id: true },
  });
  if (!post) return { success: false, code: "NOT_FOUND" };

  await prisma.post.delete({ where: { id: postId } });
  return { success: true };
}
