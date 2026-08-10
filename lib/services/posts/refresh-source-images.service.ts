import { prisma } from "@/lib/db/client";
import { extractArticle, type ExtractedArticle } from "@/lib/integrations/rss/article-extractor";
import { pickSourceImage } from "@/lib/integrations/rss/article-image";
import { isValidArticleUrl } from "@/lib/integrations/rss/invalid-feed-url";

/**
 * Re-running today's image extraction over articles whose stored image was
 * chosen by an older, worse version of it.
 *
 * `FeedItem.sourceImageUrl` is written once at ingestion and never revisited, so
 * an item ingested before the extractor learned to skip banners, ad slots and
 * related-content rails still points at whatever that older pass picked. The
 * value is not wrong in any way the row can detect — it has to be recomputed to
 * find out. So this deliberately ignores the stored value and asks the article
 * again.
 *
 * Scope is narrow on purpose:
 *   - Only RSS items, and only those backing a post that is still a `draft` —
 *     the one state where nobody has approved what they saw. A post further
 *     along has been reviewed with its current image, and re-answering the
 *     question behind a reviewer's back is not a cleanup.
 *   - The post is never touched. Neither is its MediaAsset. This writes exactly
 *     one column on FeedItem, which only decides what the "Source article" tab
 *     OFFERS; swapping the attached image stays a deliberate user action.
 *   - A recompute that finds nothing LEAVES THE STORED VALUE ALONE. A transient
 *     scrape failure and "this article has no image" are indistinguishable from
 *     here, and the existing value is the better guess in both cases.
 *
 * Idempotent: a second run over unchanged articles reports every item as
 * unchanged and writes nothing.
 */

export interface RefreshCandidate {
  feedItemId: string;
  /** The article's address. */
  url: string;
  /** What is stored today — used only to tell an update from a no-op. */
  storedImageUrl: string | null;
}

/** What happened to one article. */
export type RefreshOutcome =
  /** A different image was found; written (or would be, in a dry run). */
  | { kind: "updated"; imageUrl: string; previous: string | null }
  /** Extraction agreed with what is already stored. */
  | { kind: "unchanged"; imageUrl: string }
  /** The article yielded no usable image; the stored value was left alone. */
  | { kind: "no_image" }
  /** The write failed. The run continues. */
  | { kind: "failed"; error: string };

export interface RefreshResult {
  candidate: RefreshCandidate;
  outcome: RefreshOutcome;
}

export interface RefreshSummary {
  scanned: number;
  updated: number;
  unchanged: number;
  noImage: number;
  failed: number;
}

// ─── Injectable seams ─────────────────────────────────────────────────────────

export interface RefreshSourceImagesDeps {
  findCandidates: (limit?: number) => Promise<RefreshCandidate[]>;
  fetchArticle: (url: string) => Promise<ExtractedArticle>;
  persist: (feedItemId: string, sourceImageUrl: string) => Promise<void>;
}

export interface RefreshSourceImagesOptions {
  /** Report what would change without writing anything. */
  dryRun?: boolean;
  /** Cap on articles fetched, for a cautious first pass. */
  limit?: number;
  /** Called after each article, so a long run reports as it goes. */
  onResult?: (result: RefreshResult) => void;
}

// ─── Core logic ───────────────────────────────────────────────────────────────

export async function refreshSourceImagesCore(
  deps: RefreshSourceImagesDeps,
  options: RefreshSourceImagesOptions = {}
): Promise<RefreshSummary> {
  const candidates = await deps.findCandidates(options.limit);

  // One article, one fetch. The DB shape already guarantees this (a feed item
  // backs at most one post), but the guarantee belongs here too — this is the
  // thing that decides how many times a publisher is hit.
  const unique = new Map<string, RefreshCandidate>();
  for (const candidate of candidates) {
    if (!unique.has(candidate.feedItemId)) unique.set(candidate.feedItemId, candidate);
  }

  const summary: RefreshSummary = { scanned: 0, updated: 0, unchanged: 0, noImage: 0, failed: 0 };

  for (const candidate of unique.values()) {
    summary.scanned += 1;
    const outcome = await refreshOne(candidate, deps, options.dryRun ?? false);

    if (outcome.kind === "updated") summary.updated += 1;
    else if (outcome.kind === "unchanged") summary.unchanged += 1;
    else if (outcome.kind === "no_image") summary.noImage += 1;
    else summary.failed += 1;

    options.onResult?.({ candidate, outcome });
  }

  return summary;
}

async function refreshOne(
  candidate: RefreshCandidate,
  deps: RefreshSourceImagesDeps,
  dryRun: boolean
): Promise<RefreshOutcome> {
  try {
    // The same extraction ingestion and the picker use — one parse, same
    // priority order, same junk filtering, same SSRF gate. Never throws.
    const extracted = await deps.fetchArticle(candidate.url);
    const imageUrl = pickSourceImage({
      metaImageUrl: extracted.metaImageUrl,
      contentImageUrl: extracted.contentImageUrl,
    });

    if (!imageUrl) return { kind: "no_image" };
    if (imageUrl === candidate.storedImageUrl) return { kind: "unchanged", imageUrl };

    if (!dryRun) await deps.persist(candidate.feedItemId, imageUrl);
    return { kind: "updated", imageUrl, previous: candidate.storedImageUrl };
  } catch (error) {
    // One unreachable article, or one failed write, must not end the run.
    return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

// ─── Production wiring ────────────────────────────────────────────────────────

export const prismaRefreshSourceImagesDeps: RefreshSourceImagesDeps = {
  async findCandidates(limit) {
    const items = await prisma.feedItem.findMany({
      where: {
        source: { type: "rss" },
        // A to-one filter, so this is already one row per article.
        post: { status: "draft" },
      },
      select: { id: true, url: true, sourceImageUrl: true },
      orderBy: { publishedAt: "desc" },
      ...(limit ? { take: limit } : {}),
    });

    // Synthetic and malformed addresses can never be fetched; skipping them here
    // keeps them out of the failure count, where they would read as a problem.
    return items
      .filter((item) => isValidArticleUrl(item.url))
      .map((item) => ({
        feedItemId: item.id,
        url: item.url,
        storedImageUrl: item.sourceImageUrl,
      }));
  },

  fetchArticle: (url) => extractArticle(url),

  async persist(feedItemId, sourceImageUrl) {
    await prisma.feedItem.update({ where: { id: feedItemId }, data: { sourceImageUrl } });
  },
};

/** The single production entry point. */
export async function refreshSourceImages(
  options: RefreshSourceImagesOptions = {}
): Promise<RefreshSummary> {
  return refreshSourceImagesCore(prismaRefreshSourceImagesDeps, options);
}
