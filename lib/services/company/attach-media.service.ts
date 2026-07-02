import { prisma } from "@/lib/db/client";
import { createAuditLog, AUDIT_ACTIONS } from "@/lib/services/audit/audit-log.service";

export interface AttachedMediaDTO {
  id: string;
  url: string;
  width: number | null;
  height: number | null;
}

export type AttachMediaResult =
  | { success: true; media: AttachedMediaDTO }
  | {
      success: false;
      code: "NOT_FOUND" | "FORBIDDEN" | "INVALID_STATUS";
      message?: string;
    };

export async function attachMedia(
  postId: string,
  mediaId: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<AttachMediaResult> {
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
      message: "Image can only be attached to draft posts.",
    };
  }

  // Verify media belongs to the same company (prevents cross-company access)
  const asset = await prisma.mediaAsset.findFirst({
    where: { id: mediaId, companyId: post.companyId },
    select: { id: true, url: true, width: true, height: true },
  });

  if (!asset) return { success: false, code: "NOT_FOUND" };

  await prisma.post.update({
    where: { id: postId },
    data: { mediaAssetId: asset.id },
  });

  await createAuditLog({
    companyId: post.companyId,
    userId,
    action: AUDIT_ACTIONS.MEDIA_ATTACHED,
    entityType: "post",
    entityId: postId,
    metadata: { mediaAssetId: asset.id, url: asset.url },
  });

  return {
    success: true,
    media: {
      id: asset.id,
      url: asset.url,
      width: asset.width,
      height: asset.height,
    },
  };
}
