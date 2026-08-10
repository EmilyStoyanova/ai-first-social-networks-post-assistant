import { prisma } from "@/lib/db/client";
import { deriveProvider } from "@/lib/services/company/list-media.service";

/**
 * The images this post is holding — the one it is showing and the one a switch
 * displaced.
 *
 * What it is for: the picker should not make a user regenerate an image the post
 * already paid for. The AI tab lists the post's AI assets above the prompt so
 * they can be put back with one click, and the gallery tab floats these to the
 * top of the company's images.
 *
 * The set is exactly `Post.mediaAssetId` + `Post.previousMediaAssetId`. Those two
 * pointers ARE the post↔media relation in this schema — there is no history
 * table, and inventing one would be storing a second time what the gallery
 * already holds. So a post that has been regenerated several times surfaces its
 * two most recent assets here; the earlier ones are never deleted and stay
 * reachable through the company gallery on the neighbouring tab.
 *
 * Read-only. Attaching one of these is the existing attach-media call.
 */

export interface PostMediaItem {
  id: string;
  url: string;
  width: number | null;
  height: number | null;
  createdAt: string;
  provider: "LEONARDO" | "MOCK" | "USER_UPLOAD";
  /** `ai` for a generated image, `user_upload` for an upload or an article import. */
  generatedBy: string;
  /** The article address this was imported from. Non-null only for a source image. */
  sourceUrl: string | null;
  /** The image the post is showing right now. */
  isCurrent: boolean;
  /** The image displaced by the last switch — one click from being current again. */
  isPrevious: boolean;
}

export type ListPostMediaResult =
  { success: true; media: PostMediaItem[] } | { success: false; code: "NOT_FOUND" | "FORBIDDEN" };

// ─── Injectable seams ─────────────────────────────────────────────────────────

/** A MediaAsset row, as this service needs to see it. */
export interface PostMediaRow {
  id: string;
  url: string;
  width: number | null;
  height: number | null;
  createdAt: Date;
  cloudinaryId: string;
  generatedBy: string;
  sourceUrl: string | null;
}

export interface PostMediaContext {
  companyId: string;
  current: PostMediaRow | null;
  previous: PostMediaRow | null;
}

export interface ListPostMediaDeps {
  loadContext: (postId: string) => Promise<PostMediaContext | null>;
  /** The member's role, or null when the user is not a member at all. */
  loadRole: (companyId: string, userId: string) => Promise<string | null>;
}

// ─── Core logic ───────────────────────────────────────────────────────────────

export async function listPostMediaCore(
  postId: string,
  userId: string,
  isGlobalAdmin: boolean,
  deps: ListPostMediaDeps
): Promise<ListPostMediaResult> {
  const context = await deps.loadContext(postId);
  if (!context) return { success: false, code: "NOT_FOUND" };

  if (!isGlobalAdmin) {
    const role = await deps.loadRole(context.companyId, userId);
    // A non-member must not learn that the post exists.
    if (!role) return { success: false, code: "NOT_FOUND" };
    if (role !== "owner" && role !== "editor") return { success: false, code: "FORBIDDEN" };
  }

  const media: PostMediaItem[] = [];
  const seen = new Set<string>();

  // Current first — it is what the user is looking at, so it anchors both lists.
  for (const [row, isCurrent] of [
    [context.current, true],
    [context.previous, false],
  ] as const) {
    // The two columns should never point at the same asset (every switch rewrites
    // both), but showing one image twice would read as a bug, so dedupe anyway.
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    media.push({
      id: row.id,
      url: row.url,
      width: row.width,
      height: row.height,
      createdAt: row.createdAt.toISOString(),
      provider: deriveProvider(row.cloudinaryId, row.generatedBy),
      generatedBy: row.generatedBy,
      sourceUrl: row.sourceUrl,
      isCurrent,
      isPrevious: !isCurrent,
    });
  }

  return { success: true, media };
}

// ─── Production wiring ────────────────────────────────────────────────────────

const ASSET_FIELDS = {
  id: true,
  url: true,
  width: true,
  height: true,
  createdAt: true,
  cloudinaryId: true,
  generatedBy: true,
  sourceUrl: true,
} as const;

export const prismaListPostMediaDeps: ListPostMediaDeps = {
  async loadContext(postId) {
    const post = await prisma.post.findUnique({
      where: { id: postId },
      select: {
        companyId: true,
        mediaAsset: { select: ASSET_FIELDS },
        previousMediaAsset: { select: ASSET_FIELDS },
      },
    });
    if (!post) return null;
    return {
      companyId: post.companyId,
      current: post.mediaAsset,
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
};

/** The single production entry point. */
export async function listPostMedia(
  postId: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<ListPostMediaResult> {
  return listPostMediaCore(postId, userId, isGlobalAdmin, prismaListPostMediaDeps);
}
