import { prisma } from "@/lib/db/client";
import {
  resolvePostOrigin,
  type OriginSourceType,
  type PostOriginView,
} from "@/lib/posts/post-origin";

export interface PostItem {
  id: string;
  companyId: string;
  channel: string;
  status: string;
  text: string;
  hashtags: string[];
  imagePrompt: string | null;
  notes: string | null;
  llmProvider: string | null;
  llmModel: string | null;
  mediaUrl?: string | null;
  /**
   * The main image of the original article, when this post came from an RSS
   * article that had one. Null everywhere else — a brand-setup post, a prompt /
   * calendar / product-page source, an article with no usable image, or an item
   * ingested before the column existed. Null means the card never offers the
   * action at all.
   */
  sourceImageUrl: string | null;
  /** True when the attached image IS the article's — the card then offers the way back. */
  usingSourceImage: boolean;
  /** The image a switch displaced, restorable without regenerating. */
  previousMediaUrl: string | null;
  approvedById: string | null;
  publishedPostUrl: string | null;
  /** When the post is due to go out. Null for drafts that were never scheduled. */
  scheduledFor: string | null;
  /**
   * True when a person chose this post's publish time — in a bulk run, in the
   * single-post generation form, or from the card itself. Such a schedule is
   * honoured exactly (the publisher neither fires it early nor fires it late,
   * see lib/scheduling/publish-window), so the card presents the time as a
   * commitment; an automatic post's `scheduledFor` is an estimate and is shown
   * as one.
   */
  manuallyScheduled: boolean;
  /** Where the post was written from — a content source, or Brand Setup. */
  origin: PostOriginView;
  /**
   * The content TOPIC this post is one channel's version of, or null.
   *
   * Null for every post written before multi-channel generation, and for every
   * post cron writes — those are single, ungrouped posts and the UI keeps
   * rendering them one card each. A non-null id means siblings may exist: the
   * grid collapses posts sharing one into a single card with a channel selector
   * (see lib/posts/post-groups.ts).
   *
   * Deliberately NOT `generationBatchId`, which answers a different question —
   * one bulk run of five topics across three channels stamps the same batch id
   * on all fifteen posts, so grouping by it would fold the whole run into one
   * card.
   */
  contentGroupId: string | null;
  createdAt: string;
}

export type ListPostsResult =
  { success: true; posts: PostItem[] } | { success: false; code: "NOT_FOUND" };

const SELECT = {
  id: true,
  companyId: true,
  channel: true,
  status: true,
  content: true,
  hashtags: true,
  imagePrompt: true,
  notes: true,
  llmProvider: true,
  llmModel: true,
  approvedById: true,
  publishedPostUrl: true,
  scheduledFor: true,
  manuallyScheduled: true,
  contentGroupId: true,
  createdAt: true,
  mediaAsset: { select: { url: true, sourceUrl: true } },
  previousMediaAsset: { select: { url: true } },
  // Frozen provenance — authoritative, and immune to a later source rename or
  // delete. The join below is the fallback for posts generated before it.
  originType: true,
  originSourceType: true,
  originSourceName: true,
  originSourceTitle: true,
  originSourceUrl: true,
  primaryFeedItem: {
    select: {
      title: true,
      url: true,
      sourceImageUrl: true,
      source: { select: { name: true, type: true } },
    },
  },
} as const;

/**
 * The article image this post could switch to.
 *
 * Deliberately read from the LIVE feed item rather than the frozen origin
 * snapshot: unlike provenance, this is an action the user is about to take, so
 * it must reflect what is actually available now. A post whose source was
 * deleted has no feed item and therefore no offer — correct, since the article
 * it pointed at is gone.
 *
 * Restricted to `rss`. A prompt or calendar event has no original article at
 * all, and ingestion resolves an image for neither.
 */
export function resolveSourceImageUrl(
  primaryFeedItem: {
    sourceImageUrl: string | null;
    source: { type: string };
  } | null
): string | null {
  if (!primaryFeedItem || primaryFeedItem.source.type !== "rss") return null;
  return primaryFeedItem.sourceImageUrl;
}

function toItem(r: {
  id: string;
  companyId: string;
  channel: string;
  status: string;
  content: string;
  hashtags: string[];
  imagePrompt: string | null;
  notes: string | null;
  llmProvider: string | null;
  llmModel: string | null;
  approvedById: string | null;
  publishedPostUrl: string | null;
  mediaAsset: { url: string; sourceUrl: string | null } | null;
  previousMediaAsset: { url: string } | null;
  originType: "brand_setup" | "content_source" | null;
  originSourceType: OriginSourceType | null;
  originSourceName: string | null;
  originSourceTitle: string | null;
  originSourceUrl: string | null;
  primaryFeedItem: {
    title: string | null;
    url: string;
    sourceImageUrl: string | null;
    source: { name: string; type: string };
  } | null;
  scheduledFor: Date | null;
  manuallyScheduled: boolean;
  contentGroupId: string | null;
  createdAt: Date;
}): PostItem {
  const sourceImageUrl = resolveSourceImageUrl(r.primaryFeedItem);
  return {
    id: r.id,
    companyId: r.companyId,
    channel: r.channel.toUpperCase(),
    status: r.status.toUpperCase(),
    text: r.content,
    hashtags: r.hashtags,
    imagePrompt: r.imagePrompt,
    notes: r.notes,
    llmProvider: r.llmProvider,
    llmModel: r.llmModel,
    approvedById: r.approvedById,
    publishedPostUrl: r.publishedPostUrl,
    mediaUrl: r.mediaAsset?.url ?? null,
    sourceImageUrl,
    // The attached asset was imported from THIS article's image — not merely
    // imported from somewhere, which is why the two URLs are compared rather
    // than just checking that sourceUrl is set.
    usingSourceImage: sourceImageUrl !== null && r.mediaAsset?.sourceUrl === sourceImageUrl,
    previousMediaUrl: r.previousMediaAsset?.url ?? null,
    origin: resolvePostOrigin(r, r.primaryFeedItem),
    scheduledFor: r.scheduledFor?.toISOString() ?? null,
    manuallyScheduled: r.manuallyScheduled,
    contentGroupId: r.contentGroupId,
    createdAt: r.createdAt.toISOString(),
  };
}

export async function listPosts(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean,
  statusFilter?: string
): Promise<ListPostsResult> {
  let companyId: string;

  if (isGlobalAdmin) {
    const company = await prisma.company.findUnique({ where: { slug }, select: { id: true } });
    if (!company) return { success: false, code: "NOT_FOUND" };
    companyId = company.id;
  } else {
    const membership = await prisma.companyMember.findFirst({
      where: { company: { slug }, userId },
      select: { companyId: true },
    });
    if (!membership) return { success: false, code: "NOT_FOUND" };
    companyId = membership.companyId;
  }

  const rows = await prisma.post.findMany({
    where: {
      companyId,
      ...(statusFilter ? { status: statusFilter as never } : {}),
    },
    orderBy: { createdAt: "desc" },
    select: SELECT,
  });

  return { success: true, posts: rows.map(toItem) };
}
