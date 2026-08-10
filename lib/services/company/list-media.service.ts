import { prisma } from "@/lib/db/client";
import { Prisma, type SocialChannel } from "@prisma/client";

export interface MediaItem {
  id: string;
  url: string;
  width: number | null;
  height: number | null;
  provider: "LEONARDO" | "MOCK" | "USER_UPLOAD";
  createdAt: string;
  post: {
    id: string;
    channel: string;
    status: string;
  } | null;
}

export interface ListMediaOptions {
  channel?: string;
  provider?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
}

export type ListMediaResult =
  | {
      success: true;
      items: MediaItem[];
      total: number;
      page: number;
      pageSize: number;
    }
  | { success: false; code: "NOT_FOUND" };

const VALID_CHANNELS = ["facebook", "linkedin", "instagram", "tiktok"] as const;

function isValidChannel(v: string): v is (typeof VALID_CHANNELS)[number] {
  return (VALID_CHANNELS as readonly string[]).includes(v);
}

/** Exported so the post-scoped media list labels an asset identically. */
export function deriveProvider(
  cloudinaryId: string,
  generatedBy: string
): "LEONARDO" | "MOCK" | "USER_UPLOAD" {
  if (cloudinaryId === "mock-asset-id") return "MOCK";
  if (generatedBy === "user_upload") return "USER_UPLOAD";
  return "LEONARDO";
}

function buildWhere(
  companyId: string,
  channel?: string,
  provider?: string
): Prisma.MediaAssetWhereInput {
  const where: Prisma.MediaAssetWhereInput = { companyId };

  if (channel) {
    const ch = channel.toLowerCase();
    if (isValidChannel(ch)) {
      where.posts = { some: { channel: ch as SocialChannel } };
    }
  }

  if (provider) {
    const p = provider.toLowerCase();
    if (p === "mock") {
      where.cloudinaryId = "mock-asset-id";
    } else if (p === "leonardo") {
      where.cloudinaryId = { not: "mock-asset-id" };
    }
  }

  return where;
}

export async function listMedia(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean,
  options: ListMediaOptions = {}
): Promise<ListMediaResult> {
  const { channel, provider, sort, page = 1, pageSize = 24 } = options;
  const safePageSize = Math.min(Math.max(Math.floor(pageSize), 1), 100);
  const safePage = Math.max(Math.floor(page), 1);

  let companyId: string;

  if (isGlobalAdmin) {
    const company = await prisma.company.findUnique({
      where: { slug },
      select: { id: true },
    });
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

  const where = buildWhere(companyId, channel, provider);
  const orderBy: Prisma.MediaAssetOrderByWithRelationInput = {
    createdAt: sort === "oldest" ? "asc" : "desc",
  };

  const [rows, total] = await Promise.all([
    prisma.mediaAsset.findMany({
      where,
      orderBy,
      skip: (safePage - 1) * safePageSize,
      take: safePageSize,
      select: {
        id: true,
        url: true,
        width: true,
        height: true,
        cloudinaryId: true,
        generatedBy: true,
        createdAt: true,
        posts: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { id: true, channel: true, status: true },
        },
      },
    }),
    prisma.mediaAsset.count({ where }),
  ]);

  const items: MediaItem[] = rows.map((r) => {
    const firstPost = r.posts[0] ?? null;
    return {
      id: r.id,
      url: r.url,
      width: r.width,
      height: r.height,
      provider: deriveProvider(r.cloudinaryId, r.generatedBy),
      createdAt: r.createdAt.toISOString(),
      post: firstPost
        ? {
            id: firstPost.id,
            channel: firstPost.channel.toUpperCase(),
            status: firstPost.status.toUpperCase(),
          }
        : null,
    };
  });

  return { success: true, items, total, page: safePage, pageSize: safePageSize };
}
