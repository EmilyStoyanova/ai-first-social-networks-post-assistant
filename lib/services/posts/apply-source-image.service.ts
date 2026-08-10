import { prisma } from "@/lib/db/client";
import { AUDIT_ACTIONS, createAuditLog } from "@/lib/services/audit/audit-log.service";
import { uploadImageToCloudinary } from "@/lib/integrations/cloudinary/upload-image";
import { fetchRemoteImage } from "@/lib/integrations/images/fetch-remote-image";

/**
 * Replacing a post's AI image with the main image of the article it was written
 * from.
 *
 * Never a fallback and never automatic: generation still produces an AI image
 * exactly as before, and this runs only when a person asks for it, on a post
 * that already exists.
 *
 * Two rules shape the implementation:
 *
 *  • The external image is never hotlinked. It is downloaded here (through the
 *    SSRF gate), validated, and pushed through the same Cloudinary pipeline as
 *    every other asset, so a published post never depends on a publisher's CDN
 *    still serving the file.
 *  • The AI image is never deleted. Its MediaAsset stays exactly where it was
 *    and the post keeps a pointer to it in `previousMediaAssetId`, so switching
 *    back costs nothing — see restore-previous-image.service.ts.
 */

export interface PostImageDTO {
  id: string;
  url: string;
  width: number | null;
  height: number | null;
}

export type ApplySourceImageResult =
  | {
      success: true;
      media: PostImageDTO;
      /** The image this displaced — what "Use AI image" would restore. */
      previousMediaId: string | null;
      /** True when the article image was already attached and nothing changed. */
      unchanged: boolean;
    }
  | {
      success: false;
      code:
        | "NOT_FOUND"
        | "FORBIDDEN"
        | "NO_SOURCE_IMAGE"
        | "UNSAFE_URL"
        | "FETCH_FAILED"
        | "UNSUPPORTED_TYPE"
        | "IMAGE_TOO_LARGE"
        | "UPLOAD_FAILED";
      message?: string;
    };

// ─── Injectable seams ─────────────────────────────────────────────────────────
//
// Function seams rather than a Prisma-shaped mock: this service's value is in
// its ORDER OF OPERATIONS (validate → download → upload → repoint, and never
// touch the post if an earlier step fails), and that is what the tests need to
// pin down without a database or a network.

/** The post, as this service needs to see it. */
export interface SourceImageContext {
  companyId: string;
  companySlug: string;
  mediaAssetId: string | null;
  /** The article's image, or null when there is no article / no image / not RSS. */
  sourceImageUrl: string | null;
}

export interface CreateImportedAssetInput {
  companyId: string;
  sourceUrl: string;
  cloudinaryId: string;
  url: string;
  width: number;
  height: number;
  uploadedBy: string;
}

export interface ApplySourceImageDeps {
  loadContext: (postId: string) => Promise<SourceImageContext | null>;
  /** The member's role, or null when the user is not a member at all. */
  loadRole: (companyId: string, userId: string) => Promise<string | null>;
  /** An asset already imported from this exact URL for this company, if any. */
  findImported: (companyId: string, sourceUrl: string) => Promise<PostImageDTO | null>;
  createImported: (input: CreateImportedAssetInput) => Promise<PostImageDTO>;
  setPostImage: (
    postId: string,
    mediaAssetId: string,
    previousMediaAssetId: string | null
  ) => Promise<void>;
  fetchImage: typeof fetchRemoteImage;
  upload: typeof uploadImageToCloudinary;
  audit: (input: {
    companyId: string;
    userId: string;
    postId: string;
    mediaAssetId: string;
    url: string;
    sourceUrl: string;
  }) => Promise<void>;
}

// ─── Core logic ───────────────────────────────────────────────────────────────

export async function applySourceImageCore(
  postId: string,
  userId: string,
  isGlobalAdmin: boolean,
  deps: ApplySourceImageDeps
): Promise<ApplySourceImageResult> {
  const context = await deps.loadContext(postId);
  if (!context) return { success: false, code: "NOT_FOUND" };

  if (!isGlobalAdmin) {
    const role = await deps.loadRole(context.companyId, userId);
    // A non-member must not learn that the post exists.
    if (!role) return { success: false, code: "NOT_FOUND" };
    if (role !== "owner" && role !== "editor") return { success: false, code: "FORBIDDEN" };
  }

  const sourceUrl = context.sourceImageUrl;
  if (!sourceUrl) return { success: false, code: "NO_SOURCE_IMAGE" };

  // Already imported once — reuse the asset rather than paying for a second
  // download and upload of a byte-identical file.
  const existing = await deps.findImported(context.companyId, sourceUrl);
  if (existing) {
    if (context.mediaAssetId === existing.id) {
      // Nothing to do, and crucially nothing to overwrite: writing the swap here
      // would set previousMediaAssetId to the source image itself and strand the
      // AI image the user still wants to get back to.
      return { success: true, media: existing, previousMediaId: null, unchanged: true };
    }
    await deps.setPostImage(postId, existing.id, context.mediaAssetId);
    await deps.audit({
      companyId: context.companyId,
      userId,
      postId,
      mediaAssetId: existing.id,
      url: existing.url,
      sourceUrl,
    });
    return {
      success: true,
      media: existing,
      previousMediaId: context.mediaAssetId,
      unchanged: false,
    };
  }

  const fetched = await deps.fetchImage(sourceUrl);
  if (!fetched.success) {
    // Every failure below returns BEFORE any write, so a post whose source image
    // has rotted keeps the image it already had.
    return {
      success: false,
      // A zero-byte body is a failed download by any useful definition, so it is
      // folded in rather than given the caller a code of its own.
      code: fetched.code === "EMPTY_IMAGE" ? "FETCH_FAILED" : fetched.code,
      message: fetched.message,
    };
  }

  const uploaded = await deps.upload(
    fetched.blob,
    `companies/${context.companySlug}`,
    "source-image"
  );
  if (!uploaded.success) {
    return { success: false, code: "UPLOAD_FAILED", message: uploaded.message };
  }

  const asset = await deps.createImported({
    companyId: context.companyId,
    sourceUrl,
    cloudinaryId: uploaded.asset.publicId,
    url: uploaded.asset.url,
    width: uploaded.asset.width,
    height: uploaded.asset.height,
    uploadedBy: userId,
  });

  await deps.setPostImage(postId, asset.id, context.mediaAssetId);
  await deps.audit({
    companyId: context.companyId,
    userId,
    postId,
    mediaAssetId: asset.id,
    url: asset.url,
    sourceUrl,
  });

  return { success: true, media: asset, previousMediaId: context.mediaAssetId, unchanged: false };
}

// ─── Production wiring ────────────────────────────────────────────────────────

const ASSET_FIELDS = { id: true, url: true, width: true, height: true } as const;

export const prismaSourceImageDeps: ApplySourceImageDeps = {
  async loadContext(postId) {
    const post = await prisma.post.findUnique({
      where: { id: postId },
      select: {
        companyId: true,
        mediaAssetId: true,
        company: { select: { slug: true } },
        primaryFeedItem: {
          select: { sourceImageUrl: true, source: { select: { type: true } } },
        },
      },
    });
    if (!post) return null;

    const item = post.primaryFeedItem;
    return {
      companyId: post.companyId,
      companySlug: post.company.slug,
      mediaAssetId: post.mediaAssetId,
      // Only an RSS article is an external article in this model. A prompt, a
      // calendar event and a product page all reach here through the same
      // relation, and none of them is the "original article" this feature is
      // about — ingestion never resolves an image for them either, so this is
      // belt and braces rather than the only guard.
      sourceImageUrl: item?.source.type === "rss" ? item.sourceImageUrl : null,
    };
  },

  async loadRole(companyId, userId) {
    const membership = await prisma.companyMember.findFirst({
      where: { companyId, userId },
      select: { role: true },
    });
    return membership?.role ?? null;
  },

  async findImported(companyId, sourceUrl) {
    return prisma.mediaAsset.findFirst({
      where: { companyId, sourceUrl },
      orderBy: { createdAt: "desc" },
      select: ASSET_FIELDS,
    });
  },

  async createImported(input) {
    return prisma.mediaAsset.create({
      data: {
        companyId: input.companyId,
        cloudinaryId: input.cloudinaryId,
        url: input.url,
        width: input.width,
        height: input.height,
        // Not AI, and not something the user picked off their disk either — the
        // enum has no third value, and `sourceUrl` is what actually records the
        // provenance.
        generatedBy: "user_upload",
        sourceUrl: input.sourceUrl,
        uploadedBy: input.uploadedBy,
      },
      select: ASSET_FIELDS,
    });
  },

  async setPostImage(postId, mediaAssetId, previousMediaAssetId) {
    await prisma.post.update({
      where: { id: postId },
      data: { mediaAssetId, previousMediaAssetId },
    });
  },

  fetchImage: fetchRemoteImage,
  upload: uploadImageToCloudinary,

  async audit(input) {
    await createAuditLog({
      companyId: input.companyId,
      userId: input.userId,
      action: AUDIT_ACTIONS.MEDIA_ATTACHED,
      entityType: "post",
      entityId: input.postId,
      metadata: {
        mediaAssetId: input.mediaAssetId,
        url: input.url,
        origin: "source_article",
        sourceUrl: input.sourceUrl,
      },
    });
  },
};

/** The single production entry point. */
export async function applySourceImage(
  postId: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<ApplySourceImageResult> {
  return applySourceImageCore(postId, userId, isGlobalAdmin, prismaSourceImageDeps);
}
