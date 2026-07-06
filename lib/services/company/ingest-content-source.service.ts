import { prisma } from "@/lib/db/client";
import { parseFeed } from "@/lib/integrations/rss/parser";
import { scrapeProductPage } from "@/lib/integrations/product-page/scraper";

export type IngestContentSourceResult =
  | { success: true; created: number; updated: number }
  | { success: false; code: "NOT_FOUND" | "FORBIDDEN" | "INGEST_FAILED"; message?: string };

async function upsertFeedItem(
  sourceId: string,
  companyId: string,
  url: string,
  title: string | null,
  content: string | null,
  publishedAt: Date | null,
  existingUrls: Set<string>
): Promise<"created" | "updated"> {
  if (existingUrls.has(url)) {
    await prisma.feedItem.update({
      where: { sourceId_url: { sourceId, url } },
      data: { title, content, publishedAt },
    });
    return "updated";
  } else {
    await prisma.feedItem.create({
      data: { sourceId, companyId, url, title, content, publishedAt },
    });
    existingUrls.add(url);
    return "created";
  }
}

/** The subset of a ContentSource row the ingestion core needs. */
export interface IngestableSource {
  id: string;
  type: string;
  name: string;
  config: unknown;
}

/**
 * System-level ingestion core — no RBAC. Fetches the source, upserts feed
 * items, and stamps lastFetchedAt. Throws on fetch/parse failure.
 * Used by both the user-triggered service below and the cron dispatcher.
 */
export async function runSourceIngestion(
  source: IngestableSource,
  companyId: string
): Promise<{ created: number; updated: number }> {
  const sourceId = source.id;
  const config = source.config as Record<string, string>;

  // Pre-fetch existing URLs for this source to avoid N+1 existence checks
  const existingRows = await prisma.feedItem.findMany({
    where: { sourceId },
    select: { url: true },
  });
  const existingUrls = new Set(existingRows.map((r) => r.url));

  let created = 0;
  let updated = 0;

  if (source.type === "rss") {
    const items = await parseFeed(config.url);
    for (const item of items) {
      if (!item.url) continue;
      const outcome = await upsertFeedItem(
        sourceId,
        companyId,
        item.url,
        item.title,
        item.summary,
        item.publishedAt,
        existingUrls
      );
      if (outcome === "created") created++;
      else updated++;
    }
  } else if (source.type === "product_page") {
    const meta = await scrapeProductPage(config.url);
    const content = JSON.stringify({
      title: meta.ogTitle ?? meta.title,
      description: meta.ogDescription ?? meta.description,
      image: meta.ogImage,
    });
    const outcome = await upsertFeedItem(
      sourceId,
      companyId,
      config.url,
      meta.ogTitle ?? meta.title,
      content,
      null,
      existingUrls
    );
    if (outcome === "created") created++;
    else updated++;
  } else if (source.type === "prompt") {
    const stableUrl = `prompt:${sourceId}`;
    const outcome = await upsertFeedItem(
      sourceId,
      companyId,
      stableUrl,
      source.name,
      config.promptText,
      null,
      existingUrls
    );
    if (outcome === "created") created++;
    else updated++;
  } else if (source.type === "calendar_event") {
    const stableUrl = `event:${sourceId}`;
    const content = JSON.stringify({
      title: config.title,
      date: config.date,
      description: config.description ?? null,
    });
    const publishedAt = config.date ? new Date(config.date) : null;
    const outcome = await upsertFeedItem(
      sourceId,
      companyId,
      stableUrl,
      config.title,
      content,
      publishedAt,
      existingUrls
    );
    if (outcome === "created") created++;
    else updated++;
  }

  await prisma.contentSource.update({
    where: { id: sourceId },
    data: { lastFetchedAt: new Date() },
  });

  return { created, updated };
}

export async function ingestContentSource(
  slug: string,
  sourceId: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<IngestContentSourceResult> {
  let companyId: string;

  if (isGlobalAdmin) {
    const company = await prisma.company.findUnique({ where: { slug }, select: { id: true } });
    if (!company) return { success: false, code: "NOT_FOUND" };
    companyId = company.id;
  } else {
    const membership = await prisma.companyMember.findFirst({
      where: { company: { slug }, userId },
      select: { companyId: true, role: true },
    });
    if (!membership) return { success: false, code: "NOT_FOUND" };
    if (membership.role !== "owner") return { success: false, code: "FORBIDDEN" };
    companyId = membership.companyId;
  }

  const source = await prisma.contentSource.findFirst({
    where: { id: sourceId, companyId },
  });
  if (!source) return { success: false, code: "NOT_FOUND" };

  try {
    const { created, updated } = await runSourceIngestion(source, companyId);
    return { success: true, created, updated };
  } catch (err) {
    return {
      success: false,
      code: "INGEST_FAILED",
      message: err instanceof Error ? err.message : "Unknown error during ingestion.",
    };
  }
}
