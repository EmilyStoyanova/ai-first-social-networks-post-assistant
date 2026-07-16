import { prisma } from "@/lib/db/client";
import { parseFeed } from "@/lib/integrations/rss/parser";
import { scrapeProductPage } from "@/lib/integrations/product-page/scraper";
import { extractArticleContent } from "@/lib/integrations/rss/article-extractor";
import {
  computeTranslationHash,
  isTranslatableSourceType,
  resolveTranslationConfig,
  type TranslationConfig,
} from "@/lib/ai/feed-item-translation";
import type { Prisma } from "@prisma/client";

export type IngestContentSourceResult =
  | { success: true; created: number; updated: number }
  | { success: false; code: "NOT_FOUND" | "FORBIDDEN" | "INGEST_FAILED"; message?: string };

/** What ingestion knows about an existing row's translation state. */
interface ExistingTranslation {
  translationHash: string | null;
  translationStatus: string | null;
}

/**
 * Translation state to write for a NEW item (v2-4). Eligible items enter the
 * cron queue as "pending"; ineligible ones are marked "skipped" so the UI can
 * say "original" rather than "not yet processed".
 */
function translationFieldsForCreate(
  cfg: TranslationConfig | null
): Partial<Prisma.FeedItemUncheckedCreateInput> {
  // Not a translatable source type — translation fields stay null entirely.
  if (!cfg) return {};
  if (!cfg.enabled) return { translationStatus: "skipped" };
  return { translationStatus: "pending", translationLanguage: cfg.targetLanguage };
}

/**
 * Translation state to write for an EXISTING item. The stored hash is the input
 * the item was last translated (or last attempted) against, so an identical hash
 * means nothing changed: leave the row exactly as it is. That preserves a
 * completed translation, an in-flight pending, and — importantly — a failed
 * item's attempt count and backoff, which a blind re-queue would reset and turn
 * into an infinite retry loop.
 */
function translationFieldsForUpdate(
  cfg: TranslationConfig | null,
  hash: string,
  existing: ExistingTranslation | undefined
): Partial<Prisma.FeedItemUncheckedUpdateInput> {
  if (!cfg) return {};
  if (!cfg.enabled) {
    // Translation was turned off for this source: stop retrying and make
    // generation fall back to the original text.
    return existing?.translationStatus === "skipped"
      ? {}
      : { translationStatus: "skipped", translationNextRetryAt: null };
  }
  if (existing && existing.translationHash === hash) return {};

  // New or changed input (or a changed target language) — a fresh attempt budget.
  return {
    translationStatus: "pending",
    translationLanguage: cfg.targetLanguage,
    translationAttemptCount: 0,
    translationError: null,
    translationNextRetryAt: null,
  };
}

async function upsertFeedItem(
  sourceId: string,
  companyId: string,
  url: string,
  title: string | null,
  content: string | null,
  publishedAt: Date | null,
  existingUrls: Set<string>,
  translation: TranslationConfig | null,
  existingTranslations: Map<string, ExistingTranslation>
): Promise<"created" | "updated"> {
  if (existingUrls.has(url)) {
    const hash = computeTranslationHash(title, content, translation?.targetLanguage ?? "");
    await prisma.feedItem.update({
      where: { sourceId_url: { sourceId, url } },
      // title/content always carry the ORIGINAL article text — translation never
      // writes here (v2-4).
      data: {
        title,
        content,
        publishedAt,
        ...translationFieldsForUpdate(translation, hash, existingTranslations.get(url)),
      },
    });
    return "updated";
  } else {
    await prisma.feedItem.create({
      data: {
        sourceId,
        companyId,
        url,
        title,
        content,
        publishedAt,
        ...translationFieldsForCreate(translation),
      },
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

  // Translation target defaults to the company's content language (v2-4).
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { defaultLang: true },
  });
  // null for source types that are never translated (prompt/product_page/
  // calendar_event) — their rows keep null translation fields.
  const translation = isTranslatableSourceType(source.type)
    ? resolveTranslationConfig(source.type, source.config, company?.defaultLang ?? "en")
    : null;

  // Pre-fetch existing URLs for this source to avoid N+1 existence checks
  const existingRows = await prisma.feedItem.findMany({
    where: { sourceId },
    select: { url: true, translationHash: true, translationStatus: true },
  });
  const existingUrls = new Set(existingRows.map((r) => r.url));
  const existingTranslations = new Map<string, ExistingTranslation>(
    existingRows.map((r) => [
      r.url,
      { translationHash: r.translationHash, translationStatus: r.translationStatus },
    ])
  );

  let created = 0;
  let updated = 0;

  if (source.type === "rss") {
    const items = await parseFeed(config.url);
    for (const item of items) {
      if (!item.url) continue;
      const extracted = await extractArticleContent(item.url);
      const content = extracted ?? item.summary;
      const outcome = await upsertFeedItem(
        sourceId,
        companyId,
        item.url,
        item.title,
        content,
        item.publishedAt,
        existingUrls,
        translation,
        existingTranslations
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
      existingUrls,
      translation,
      existingTranslations
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
      existingUrls,
      translation,
      existingTranslations
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
      existingUrls,
      translation,
      existingTranslations
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
