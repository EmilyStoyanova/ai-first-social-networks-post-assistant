import { prisma } from "@/lib/db/client";

export interface FeedItemRow {
  id: string;
  sourceId: string;
  title: string | null;
  content: string | null;
  url: string;
  publishedAt: string | null;
  enabled: boolean;
  createdAt: string;
}

export type ListFeedItemsResult =
  { success: true; items: FeedItemRow[] } | { success: false; code: "NOT_FOUND" | "FORBIDDEN" };

async function resolveCompanyAndSource(
  slug: string,
  sourceId: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<{ ok: true; companyId: string } | { ok: false; code: "NOT_FOUND" | "FORBIDDEN" }> {
  let companyId: string;

  if (isGlobalAdmin) {
    const company = await prisma.company.findUnique({ where: { slug }, select: { id: true } });
    if (!company) return { ok: false, code: "NOT_FOUND" };
    companyId = company.id;
  } else {
    const membership = await prisma.companyMember.findFirst({
      where: { company: { slug }, userId },
      select: { companyId: true },
    });
    if (!membership) return { ok: false, code: "NOT_FOUND" };
    companyId = membership.companyId;
  }

  const source = await prisma.contentSource.findFirst({
    where: { id: sourceId, companyId },
    select: { id: true },
  });
  if (!source) return { ok: false, code: "NOT_FOUND" };

  return { ok: true, companyId };
}

const ITEMS_LIMIT = 50;

/**
 * True when the company has at least one enabled feed item from an enabled
 * source — i.e. generation would be based on an RSS article (v2-1). Used to
 * decide whether the manual source-link override is shown.
 */
export async function hasEnabledFeedItems(companyId: string): Promise<boolean> {
  const item = await prisma.feedItem.findFirst({
    where: { companyId, enabled: true, source: { enabled: true } },
    select: { id: true },
  });
  return item !== null;
}

export async function listFeedItems(
  slug: string,
  sourceId: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<ListFeedItemsResult> {
  const ctx = await resolveCompanyAndSource(slug, sourceId, userId, isGlobalAdmin);
  if (!ctx.ok) return { success: false, code: ctx.code };

  const rows = await prisma.feedItem.findMany({
    where: { sourceId },
    orderBy: [{ publishedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    take: ITEMS_LIMIT,
    select: {
      id: true,
      sourceId: true,
      title: true,
      content: true,
      url: true,
      publishedAt: true,
      enabled: true,
      createdAt: true,
    },
  });

  return {
    success: true,
    items: rows.map((r) => ({
      id: r.id,
      sourceId: r.sourceId,
      title: r.title,
      content: r.content,
      url: r.url,
      publishedAt: r.publishedAt?.toISOString() ?? null,
      enabled: r.enabled,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}
