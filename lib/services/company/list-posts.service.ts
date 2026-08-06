import { prisma } from "@/lib/db/client";
import { resolvePostOrigin, type PostOriginView } from "@/lib/posts/post-origin";

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
  approvedById: string | null;
  publishedPostUrl: string | null;
  /** When the post is due to go out. Null for drafts that were never scheduled. */
  scheduledFor: string | null;
  /** Where the post was written from — a content source, or Brand Setup. */
  origin: PostOriginView;
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
  createdAt: true,
  mediaAsset: { select: { url: true } },
  // Frozen provenance — authoritative, and immune to a later source rename or
  // delete. The join below is the fallback for posts generated before it.
  originType: true,
  originSourceName: true,
  originSourceTitle: true,
  originSourceUrl: true,
  primaryFeedItem: { select: { title: true, url: true, source: { select: { name: true } } } },
} as const;

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
  mediaAsset: { url: string } | null;
  originType: "brand_setup" | "content_source" | null;
  originSourceName: string | null;
  originSourceTitle: string | null;
  originSourceUrl: string | null;
  primaryFeedItem: { title: string | null; url: string; source: { name: string } } | null;
  scheduledFor: Date | null;
  createdAt: Date;
}): PostItem {
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
    origin: resolvePostOrigin(r, r.primaryFeedItem),
    scheduledFor: r.scheduledFor?.toISOString() ?? null,
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
