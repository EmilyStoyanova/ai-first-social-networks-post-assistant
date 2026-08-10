import { prisma } from "@/lib/db/client";
import { createAuditLog } from "@/lib/services/audit/audit-log.service";

export type DeleteMediaResult =
  { success: true } | { success: false; code: "NOT_FOUND" | "FORBIDDEN"; message?: string };

export async function deleteMedia(
  slug: string,
  mediaId: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<DeleteMediaResult> {
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
    if (membership.role !== "owner") {
      return { success: false, code: "FORBIDDEN", message: "Only owners can delete media." };
    }
    companyId = membership.companyId;
  }

  const asset = await prisma.mediaAsset.findFirst({
    where: { id: mediaId, companyId },
    select: { id: true, url: true },
  });
  if (!asset) return { success: false, code: "NOT_FOUND" };

  // Detach from posts before deleting (set mediaAssetId to null)
  await prisma.post.updateMany({
    where: { mediaAssetId: mediaId },
    data: { mediaAssetId: null },
  });

  // Also clear it from any post holding it in reserve after an image switch —
  // that FK is RESTRICT, so a still-referenced asset would refuse to delete.
  await prisma.post.updateMany({
    where: { previousMediaAssetId: mediaId },
    data: { previousMediaAssetId: null },
  });

  await prisma.mediaAsset.delete({ where: { id: mediaId } });

  await createAuditLog({
    companyId,
    userId,
    action: "MEDIA_DELETED",
    entityType: "media_asset",
    entityId: mediaId,
    metadata: { url: asset.url },
  });

  return { success: true };
}
