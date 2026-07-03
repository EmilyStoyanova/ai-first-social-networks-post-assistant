import { prisma } from "@/lib/db/client";

export type DetachMediaResult =
  | { success: true }
  | { success: false; code: "NOT_FOUND" | "FORBIDDEN" | "INVALID_STATUS"; message?: string };

export async function detachMedia(
  postId: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<DetachMediaResult> {
  const post = await prisma.post.findUnique({
    where: { id: postId },
    select: { companyId: true, status: true },
  });

  if (!post) return { success: false, code: "NOT_FOUND" };

  if (!isGlobalAdmin) {
    const membership = await prisma.companyMember.findFirst({
      where: { companyId: post.companyId, userId },
      select: { role: true },
    });
    if (!membership) return { success: false, code: "NOT_FOUND" };
    if (membership.role !== "owner" && membership.role !== "editor") {
      return { success: false, code: "FORBIDDEN" };
    }
  }

  if (post.status !== "draft") {
    return {
      success: false,
      code: "INVALID_STATUS",
      message: "Image can only be removed from draft posts.",
    };
  }

  await prisma.post.update({
    where: { id: postId },
    data: { mediaAssetId: null },
  });

  return { success: true };
}
