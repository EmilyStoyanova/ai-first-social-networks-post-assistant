import { prisma } from "@/lib/db/client";
import { AUDIT_ACTIONS, createAuditLog } from "@/lib/services/audit/audit-log.service";
import { deleteImageFromCloudinary } from "@/lib/integrations/cloudinary/delete-image";

/**
 * Permanently deleting a post that never left the building — a DRAFT or a
 * REJECTED one.
 *
 * ── Why this is a hard delete, and why it is scoped so tightly ───────────────
 *
 * A post that is deleted must stop existing for generation. Two mechanisms
 * would otherwise keep repeating it back at the user:
 *
 *   • the Jaccard/recent-post check, which reads `Post` rows directly
 *     (generate-draft-post.service fetches the last 30 posts for the channel);
 *   • the semantic gate, which reads `post_semantics` joined to `posts`.
 *
 * Both are satisfied by the Post row and its PostSemantics row actually going
 * away — no filtering flag, no "deleted" status that every query then has to
 * remember to exclude. The children are deleted EXPLICITLY inside the
 * transaction rather than left to the ON DELETE CASCADE the schema also
 * declares: the cascade is a safety net in the database, this is the stated
 * intent in the code, and it is what the tests can hold onto.
 *
 * ── What may be deleted ─────────────────────────────────────────────────────
 *
 * `draft` and `rejected`, and nothing else.
 *
 * They are the same case despite looking like two. A post can only be rejected
 * out of `pending_approval` (see post-approval.service), which is upstream of
 * every publishing step — so neither status has ever been handed to Buffer, has
 * a `bufferUpdateId`, or exists anywhere outside this database. Deleting one
 * destroys nothing that happened; it removes something that was proposed and
 * turned down.
 *
 * Rejected posts are in fact the ones that most need to go. A draft is usually
 * deleted because the user changed their mind, but a rejection is a verdict —
 * "we are not saying this" — and until the row is gone the generator keeps
 * measuring new candidates against it as though it were the company's own voice,
 * through both the Jaccard window and the semantic gate. A rejected post left in
 * place quietly reserves its topic forever.
 *
 * `approved`, `sent_to_buffer` and `published` stay undeletable. Those have been
 * acted on — the last two have a counterpart on a social network that deleting a
 * row here would not touch — and their history is the point.
 *
 * ── Media ────────────────────────────────────────────────────────────────────
 *
 * A post's image is deleted only when it exists BECAUSE of this post and is
 * referenced by nothing else — see isPostExclusiveAsset. Article images and
 * gallery uploads are shared company property and are always left alone.
 *
 * Cloudinary is destroyed AFTER the transaction commits, never inside it. A
 * remote call cannot participate in a database transaction, and the failure
 * modes are not symmetric: an orphaned Cloudinary file is invisible and costs
 * pennies, whereas a committed Cloudinary delete followed by a rolled-back
 * transaction would leave a row pointing at an image that no longer loads. So
 * the database is the source of truth and Cloudinary cleanup is best-effort,
 * reported back in `orphanedCloudinaryIds` rather than failing the delete.
 */

/**
 * The statuses this service will delete — see the docblock. Lowercase, matching
 * the `PostStatus` enum as Prisma returns it.
 */
export const DELETABLE_POST_STATUSES = ["draft", "rejected"] as const;

export function isDeletableStatus(status: string): boolean {
  return (DELETABLE_POST_STATUSES as readonly string[]).includes(status);
}

export interface DeletableMediaAsset {
  id: string;
  cloudinaryId: string;
  /** MediaSource — "ai" for a generated image, "user_upload" for everything else. */
  generatedBy: string;
  /** Non-null when the image was IMPORTED from a source article. */
  sourceUrl: string | null;
}

export interface DeletablePost {
  id: string;
  status: string;
  mediaAssetId: string | null;
  previousMediaAssetId: string | null;
}

export interface DeletePostCompanyAccess {
  companyId: string;
  /** Whether this actor may delete drafts in this company (owner or global admin). */
  canDelete: boolean;
}

export interface DeletePostSummary {
  postId: string;
  /** MediaAsset rows removed because they belonged to this post alone. */
  deletedMediaAssetIds: string[];
  /**
   * Assets whose DB row is gone but whose Cloudinary resource could not be
   * destroyed. The delete still succeeded; these are remote files to sweep up.
   */
  orphanedCloudinaryIds: string[];
}

export type DeletePostResult =
  | { success: true; data: DeletePostSummary }
  | { success: false; code: "NOT_FOUND" | "FORBIDDEN" | "INVALID_STATUS"; message?: string };

export interface DeletePostDeps {
  loadAccess(
    slug: string,
    userId: string,
    isGlobalAdmin: boolean
  ): Promise<DeletePostCompanyAccess | null>;
  loadPost(postId: string, companyId: string): Promise<DeletablePost | null>;
  loadMediaAssets(ids: string[], companyId: string): Promise<DeletableMediaAsset[]>;
  /** How many OTHER posts point at this asset, through either media column. */
  countOtherPostsUsing(assetId: string, excludingPostId: string): Promise<number>;
  /** One transaction: the post, everything owned by it, then its exclusive assets. */
  deletePostAndOwnedRecords(input: { postId: string; mediaAssetIds: string[] }): Promise<void>;
  /** Best-effort remote cleanup. Returns false instead of throwing. */
  destroyCloudinaryAsset(cloudinaryId: string): Promise<boolean>;
  audit(input: {
    companyId: string;
    userId: string;
    postId: string;
    /** Which of the two deletable statuses this was — the row will not say. */
    status: string;
    deletedMediaAssetIds: string[];
    orphanedCloudinaryIds: string[];
  }): Promise<void>;
}

/**
 * Was this asset created for this post and nothing else?
 *
 * `generatedBy: "ai"` alone is the answer for images: generate-post-image always
 * runs against one named post. The `sourceUrl` check is belt and braces — an
 * imported article image is written with `generatedBy: "user_upload"` AND a
 * source url, and that row is deliberately REUSED across posts (apply-source-
 * image dedupes on companyId + sourceUrl), so deleting it would strip the image
 * from every other post drawn from the same article.
 *
 * User uploads are excluded for the same reason: they are company gallery items
 * that happen to be attached here.
 */
export function isPostExclusiveAsset(asset: DeletableMediaAsset): boolean {
  return asset.generatedBy === "ai" && asset.sourceUrl === null;
}

/**
 * Of the post's two media pointers, the assets safe to delete with it: created
 * for this post (isPostExclusiveAsset) and referenced by no other post.
 */
async function resolveExclusiveAssets(
  post: DeletablePost,
  companyId: string,
  deps: DeletePostDeps
): Promise<DeletableMediaAsset[]> {
  // Both pointers, deduped — a post can hold the same asset current AND in
  // reserve, and it must not be considered twice.
  const candidateIds = [
    ...new Set([post.mediaAssetId, post.previousMediaAssetId].filter((id): id is string => !!id)),
  ];
  if (candidateIds.length === 0) return [];

  const assets = await deps.loadMediaAssets(candidateIds, companyId);
  const exclusive: DeletableMediaAsset[] = [];

  for (const asset of assets) {
    if (!isPostExclusiveAsset(asset)) continue;
    // An AI image can still be picked out of the company gallery and attached to
    // a second post — then it is shared, whatever its provenance says.
    if ((await deps.countOtherPostsUsing(asset.id, post.id)) > 0) continue;
    exclusive.push(asset);
  }

  return exclusive;
}

export async function deletePostCore(
  slug: string,
  postId: string,
  userId: string,
  isGlobalAdmin: boolean,
  deps: DeletePostDeps
): Promise<DeletePostResult> {
  const access = await deps.loadAccess(slug, userId, isGlobalAdmin);
  // No membership → the company is not this user's to know about.
  if (!access) return { success: false, code: "NOT_FOUND" };
  if (!access.canDelete) {
    return { success: false, code: "FORBIDDEN", message: "Only owners can delete posts." };
  }

  // Scoped by companyId, so another company's post id reads as NOT_FOUND rather
  // than confirming that it exists.
  const post = await deps.loadPost(postId, access.companyId);
  if (!post) return { success: false, code: "NOT_FOUND" };

  if (!isDeletableStatus(post.status)) {
    return {
      success: false,
      code: "INVALID_STATUS",
      message: `Only draft and rejected posts can be deleted; this post is ${post.status}.`,
    };
  }

  const exclusiveAssets = await resolveExclusiveAssets(post, access.companyId, deps);
  const deletedMediaAssetIds = exclusiveAssets.map((a) => a.id);

  // Everything that must be all-or-nothing happens here. A throw propagates:
  // nothing has been destroyed remotely yet, so the caller sees a failed delete
  // over an untouched database.
  await deps.deletePostAndOwnedRecords({ postId: post.id, mediaAssetIds: deletedMediaAssetIds });

  // Past this point the delete has SUCCEEDED. Remote cleanup can only downgrade
  // to "left an orphan".
  const orphanedCloudinaryIds: string[] = [];
  for (const asset of exclusiveAssets) {
    const destroyed = await deps.destroyCloudinaryAsset(asset.cloudinaryId);
    if (!destroyed) orphanedCloudinaryIds.push(asset.cloudinaryId);
  }

  await deps.audit({
    companyId: access.companyId,
    userId,
    postId: post.id,
    status: post.status,
    deletedMediaAssetIds,
    orphanedCloudinaryIds,
  });

  return {
    success: true,
    data: { postId: post.id, deletedMediaAssetIds, orphanedCloudinaryIds },
  };
}

// ─── Production wiring ────────────────────────────────────────────────────────

export const prismaDeletePostDeps: DeletePostDeps = {
  async loadAccess(slug, userId, isGlobalAdmin) {
    if (isGlobalAdmin) {
      const company = await prisma.company.findUnique({ where: { slug }, select: { id: true } });
      if (!company) return null;
      return { companyId: company.id, canDelete: true };
    }

    const membership = await prisma.companyMember.findFirst({
      where: { company: { slug }, userId },
      select: { companyId: true, role: true },
    });
    if (!membership) return null;
    return { companyId: membership.companyId, canDelete: membership.role === "owner" };
  },

  async loadPost(postId, companyId) {
    return prisma.post.findFirst({
      where: { id: postId, companyId },
      select: { id: true, status: true, mediaAssetId: true, previousMediaAssetId: true },
    });
  },

  async loadMediaAssets(ids, companyId) {
    return prisma.mediaAsset.findMany({
      where: { id: { in: ids }, companyId },
      select: { id: true, cloudinaryId: true, generatedBy: true, sourceUrl: true },
    });
  },

  async countOtherPostsUsing(assetId, excludingPostId) {
    return prisma.post.count({
      where: {
        id: { not: excludingPostId },
        OR: [{ mediaAssetId: assetId }, { previousMediaAssetId: assetId }],
      },
    });
  },

  async deletePostAndOwnedRecords({ postId, mediaAssetIds }) {
    await prisma.$transaction(async (tx) => {
      // Explicit, in dependency order. The schema declares ON DELETE CASCADE for
      // all four, so these are normally no-ops that ran a moment early — but
      // they state the intent where it can be read and tested, and they keep the
      // guarantee if a future child table forgets its cascade.
      await tx.postSemantics.deleteMany({ where: { postId } });
      await tx.postVersion.deleteMany({ where: { postId } });
      await tx.postMetricSnapshot.deleteMany({ where: { postId } });
      await tx.postMetric.deleteMany({ where: { postId } });

      // The post BEFORE its assets: posts.previous_media_asset_id is ON DELETE
      // RESTRICT, so a still-referenced asset would refuse to go.
      await tx.post.delete({ where: { id: postId } });

      if (mediaAssetIds.length > 0) {
        await tx.mediaAsset.deleteMany({ where: { id: { in: mediaAssetIds } } });
      }
    });
  },

  async destroyCloudinaryAsset(cloudinaryId) {
    try {
      const result = await deleteImageFromCloudinary(cloudinaryId);
      if (!result.success) {
        console.warn(`[delete-post] Cloudinary delete failed for ${cloudinaryId}:`, result.message);
      }
      return result.success;
    } catch (err) {
      console.warn(`[delete-post] Cloudinary delete threw for ${cloudinaryId}:`, err);
      return false;
    }
  },

  async audit(input) {
    await createAuditLog({
      companyId: input.companyId,
      userId: input.userId,
      action: AUDIT_ACTIONS.POST_DELETED,
      entityType: "post",
      entityId: input.postId,
      metadata: {
        status: input.status,
        deletedMediaAssetIds: input.deletedMediaAssetIds,
        orphanedCloudinaryIds: input.orphanedCloudinaryIds,
      },
    });
  },
};

/** The single production entry point. */
export async function deletePost(
  slug: string,
  postId: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<DeletePostResult> {
  return deletePostCore(slug, postId, userId, isGlobalAdmin, prismaDeletePostDeps);
}
