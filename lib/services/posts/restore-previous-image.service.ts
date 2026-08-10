import { prisma } from "@/lib/db/client";
import { AUDIT_ACTIONS, createAuditLog } from "@/lib/services/audit/audit-log.service";
import type { PostImageDTO } from "./apply-source-image.service";

/**
 * Switching back to the image a source-image import displaced — in practice,
 * "Use AI image".
 *
 * This is the other half of the pair: `useSourceImage` moves the current asset
 * into `previousMediaAssetId` and never deletes it, so restoring it is a pointer
 * swap. No regeneration, no provider call, no cost.
 *
 * The swap is symmetric — the image being replaced becomes the new "previous" —
 * so a user can flip between the AI image and the article image as many times as
 * they like, and both MediaAssets survive throughout.
 */

export type RestorePreviousImageResult =
  | { success: true; media: PostImageDTO; previousMediaId: string | null }
  | {
      success: false;
      code: "NOT_FOUND" | "FORBIDDEN" | "NO_PREVIOUS_IMAGE";
      message?: string;
    };

export interface PreviousImageContext {
  companyId: string;
  mediaAssetId: string | null;
  previous: PostImageDTO | null;
}

export interface RestorePreviousImageDeps {
  loadContext: (postId: string) => Promise<PreviousImageContext | null>;
  loadRole: (companyId: string, userId: string) => Promise<string | null>;
  setPostImage: (
    postId: string,
    mediaAssetId: string,
    previousMediaAssetId: string | null
  ) => Promise<void>;
  audit: (input: {
    companyId: string;
    userId: string;
    postId: string;
    mediaAssetId: string;
    url: string;
  }) => Promise<void>;
}

export async function restorePreviousImageCore(
  postId: string,
  userId: string,
  isGlobalAdmin: boolean,
  deps: RestorePreviousImageDeps
): Promise<RestorePreviousImageResult> {
  const context = await deps.loadContext(postId);
  if (!context) return { success: false, code: "NOT_FOUND" };

  if (!isGlobalAdmin) {
    const role = await deps.loadRole(context.companyId, userId);
    if (!role) return { success: false, code: "NOT_FOUND" };
    if (role !== "owner" && role !== "editor") return { success: false, code: "FORBIDDEN" };
  }

  const previous = context.previous;
  if (!previous) return { success: false, code: "NO_PREVIOUS_IMAGE" };

  await deps.setPostImage(postId, previous.id, context.mediaAssetId);
  await deps.audit({
    companyId: context.companyId,
    userId,
    postId,
    mediaAssetId: previous.id,
    url: previous.url,
  });

  return { success: true, media: previous, previousMediaId: context.mediaAssetId };
}

// ─── Production wiring ────────────────────────────────────────────────────────

export const prismaPreviousImageDeps: RestorePreviousImageDeps = {
  async loadContext(postId) {
    const post = await prisma.post.findUnique({
      where: { id: postId },
      select: {
        companyId: true,
        mediaAssetId: true,
        previousMediaAsset: { select: { id: true, url: true, width: true, height: true } },
      },
    });
    if (!post) return null;
    return {
      companyId: post.companyId,
      mediaAssetId: post.mediaAssetId,
      previous: post.previousMediaAsset,
    };
  },

  async loadRole(companyId, userId) {
    const membership = await prisma.companyMember.findFirst({
      where: { companyId, userId },
      select: { role: true },
    });
    return membership?.role ?? null;
  },

  async setPostImage(postId, mediaAssetId, previousMediaAssetId) {
    await prisma.post.update({
      where: { id: postId },
      data: { mediaAssetId, previousMediaAssetId },
    });
  },

  async audit(input) {
    await createAuditLog({
      companyId: input.companyId,
      userId: input.userId,
      action: AUDIT_ACTIONS.MEDIA_ATTACHED,
      entityType: "post",
      entityId: input.postId,
      metadata: { mediaAssetId: input.mediaAssetId, url: input.url, origin: "restored" },
    });
  },
};

/** The single production entry point. */
export async function restorePreviousImage(
  postId: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<RestorePreviousImageResult> {
  return restorePreviousImageCore(postId, userId, isGlobalAdmin, prismaPreviousImageDeps);
}
