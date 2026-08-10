import { prisma } from "@/lib/db/client";
import { extractArticle, type ExtractedArticle } from "@/lib/integrations/rss/article-extractor";
import { pickSourceImage } from "@/lib/integrations/rss/article-image";

/**
 * Answering "does this post's article have an image we could use?".
 *
 * Ingestion resolves and stores the image on the FeedItem, so for anything
 * ingested since that landed this is a plain read. Items ingested BEFORE it have
 * `sourceImageUrl` null and would otherwise never offer the action — no backfill
 * was run, deliberately, because it would mean re-fetching every historical
 * article. So the gap is closed lazily instead: the first time someone opens the
 * picker on such a post, the article is scraped once and the result is written
 * back to the FeedItem, where every later read finds it.
 *
 * Read-only from the post's point of view — this never touches the post, its
 * media, or anything the user can see until they explicitly pick the image
 * (see apply-source-image.service.ts).
 */

export type ResolveSourceImageResult =
  | {
      success: true;
      /** The article's image, or null when the post has no article / none was found. */
      sourceImageUrl: string | null;
    }
  | { success: false; code: "NOT_FOUND" | "FORBIDDEN" };

// ─── Injectable seams ─────────────────────────────────────────────────────────

/** The article behind a post, as this service needs to see it. */
export interface ArticleContext {
  companyId: string;
  /** Null when the post has no article — brand setup, or a deleted source. */
  feedItemId: string | null;
  /** The article's address. Only meaningful for an RSS item. */
  articleUrl: string | null;
  /** True only for `rss`; a prompt / calendar event / product page has no article. */
  isArticle: boolean;
  /** What ingestion already stored, if anything. */
  sourceImageUrl: string | null;
}

export interface ResolveSourceImageDeps {
  loadContext: (postId: string) => Promise<ArticleContext | null>;
  loadRole: (companyId: string, userId: string) => Promise<string | null>;
  fetchArticle: (url: string) => Promise<ExtractedArticle>;
  persist: (feedItemId: string, sourceImageUrl: string) => Promise<void>;
}

// ─── Core logic ───────────────────────────────────────────────────────────────

export async function resolveSourceImageCore(
  postId: string,
  userId: string,
  isGlobalAdmin: boolean,
  deps: ResolveSourceImageDeps
): Promise<ResolveSourceImageResult> {
  const context = await deps.loadContext(postId);
  if (!context) return { success: false, code: "NOT_FOUND" };

  if (!isGlobalAdmin) {
    const role = await deps.loadRole(context.companyId, userId);
    // A non-member must not learn that the post exists.
    if (!role) return { success: false, code: "NOT_FOUND" };
    if (role !== "owner" && role !== "editor") return { success: false, code: "FORBIDDEN" };
  }

  // Already known — the ordinary path, and the only one that costs nothing.
  if (context.sourceImageUrl) {
    return { success: true, sourceImageUrl: context.sourceImageUrl };
  }

  if (!context.isArticle || !context.feedItemId || !context.articleUrl) {
    return { success: true, sourceImageUrl: null };
  }

  // The same extraction ingestion uses — one parse, same priority order, same
  // junk filtering. `extractArticle` never throws and enforces the SSRF gate.
  const extracted = await deps.fetchArticle(context.articleUrl);
  const sourceImageUrl = pickSourceImage({
    metaImageUrl: extracted.metaImageUrl,
    contentImageUrl: extracted.contentImageUrl,
  });

  if (!sourceImageUrl) return { success: true, sourceImageUrl: null };

  // Best effort: the answer is already correct without the write, and a failed
  // write only costs one repeated scrape next time.
  try {
    await deps.persist(context.feedItemId, sourceImageUrl);
  } catch {
    // Intentionally swallowed — see above.
  }

  return { success: true, sourceImageUrl };
}

// ─── Production wiring ────────────────────────────────────────────────────────

export const prismaResolveSourceImageDeps: ResolveSourceImageDeps = {
  async loadContext(postId) {
    const post = await prisma.post.findUnique({
      where: { id: postId },
      select: {
        companyId: true,
        primaryFeedItem: {
          select: {
            id: true,
            url: true,
            sourceImageUrl: true,
            source: { select: { type: true } },
          },
        },
      },
    });
    if (!post) return null;

    const item = post.primaryFeedItem;
    const isArticle = item?.source.type === "rss";
    return {
      companyId: post.companyId,
      feedItemId: item?.id ?? null,
      articleUrl: isArticle ? (item?.url ?? null) : null,
      isArticle,
      sourceImageUrl: isArticle ? (item?.sourceImageUrl ?? null) : null,
    };
  },

  async loadRole(companyId, userId) {
    const membership = await prisma.companyMember.findFirst({
      where: { companyId, userId },
      select: { role: true },
    });
    return membership?.role ?? null;
  },

  fetchArticle: (url) => extractArticle(url),

  async persist(feedItemId, sourceImageUrl) {
    await prisma.feedItem.update({ where: { id: feedItemId }, data: { sourceImageUrl } });
  },
};

/** The single production entry point. */
export async function resolveSourceImage(
  postId: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<ResolveSourceImageResult> {
  return resolveSourceImageCore(postId, userId, isGlobalAdmin, prismaResolveSourceImageDeps);
}
