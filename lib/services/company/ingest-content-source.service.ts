import { prisma } from "@/lib/db/client";
import { parseFeed } from "@/lib/integrations/rss/parser";
import { scrapeProductPage } from "@/lib/integrations/product-page/scraper";
import { extractArticle } from "@/lib/integrations/rss/article-extractor";
import { pickSourceImage } from "@/lib/integrations/rss/article-image";
import {
  computeTranslationHash,
  isTranslatableSourceType,
  requiresTranslationWork,
  resolveTranslationConfig,
  type TranslationConfig,
} from "@/lib/ai/feed-item-translation";
import { computeExtractionHash, extractionInstructionsOf } from "@/lib/ai/product-page-extraction";
import type { Prisma } from "@prisma/client";

export type IngestContentSourceResult =
  | {
      success: true;
      created: number;
      updated: number;
      /**
       * Feed items this run left genuinely needing translation (newly created eligible,
       * reopened by a changed hash, or still-pending/failed with attempts left). Drives
       * the manual route's translation enqueue; NOT part of the public API response.
       */
      translationWorkCreated: number;
      /**
       * Product-page items this run left needing an LLM extraction (new, or whose
       * page text / instruction changed). Drives the manual route's extraction
       * enqueue, exactly as the field above drives translation's; NOT part of the
       * public API response.
       */
      extractionWorkCreated: number;
    }
  | { success: false; code: "NOT_FOUND" | "FORBIDDEN" | "INGEST_FAILED"; message?: string };

/** What ingestion knows about an existing row's translation state. */
interface ExistingTranslation {
  translationHash: string | null;
  translationStatus: string | null;
  translationAttemptCount: number;
}

/** The same, for product-page extraction. */
export interface ExistingExtraction {
  extractionHash: string | null;
  extractionStatus: string | null;
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

/**
 * Extraction state to write for a feed item whose source carries an instruction.
 *
 * Ingestion never calls the model — it only records that there is work and what
 * input that work is against, exactly as it does for translation. The LLM step is
 * a queued job (see runPendingExtractions), because one extraction is a
 * large-context call against a self-hosted model and an HTTP ingest request is
 * the wrong place to wait for it.
 *
 * An unchanged hash on an item that already has a result leaves the row alone:
 * a cron tick that re-scrapes an unchanged page must not spend a model call, and
 * must not reset a `not_found` answer back to pending forever.
 */
export function extractionFieldsFor(
  hash: string | null,
  existing: ExistingExtraction | undefined
): Record<string, unknown> {
  // No instruction on this source — the item keeps null extraction fields, and a
  // source whose instruction was REMOVED is cleared back to that state.
  if (hash === null) {
    return existing?.extractionStatus
      ? {
          extractionStatus: null,
          extractionHash: null,
          extractedContent: null,
          extractionError: null,
          extractedAt: null,
          extractionAttemptCount: 0,
        }
      : {};
  }
  const settled =
    existing?.extractionStatus === "completed" || existing?.extractionStatus === "not_found";
  if (settled && existing?.extractionHash === hash) return {};

  return {
    extractionStatus: "pending",
    extractionHash: hash,
    extractionError: null,
    // A changed page or instruction is a fresh question, so it gets a fresh
    // attempt budget — otherwise an item that exhausted its retries on an old
    // page could never be extracted again.
    extractionAttemptCount: 0,
  };
}

/**
 * Whether the item now needs an extraction run — the enqueue signal.
 *
 * Exported, with the writer above, so the decision is testable without a
 * database: which ingests cost a model call and which do not is the part of this
 * file most worth pinning down.
 */
export function requiresExtractionWork(
  hash: string | null,
  existing: ExistingExtraction | undefined
): boolean {
  if (hash === null) return false;
  return Object.keys(extractionFieldsFor(hash, existing)).length > 0;
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
  existingTranslations: Map<string, ExistingTranslation>,
  /** The article's own image. Only RSS resolves one; every other type passes null. */
  sourceImageUrl: string | null = null,
  /**
   * sha256(pageText + instructions) for a product page with an extraction
   * instruction; null for every other item, which is what "no extraction" means.
   */
  extractionHash: string | null = null,
  existingExtractions?: Map<string, ExistingExtraction>
): Promise<{
  outcome: "created" | "updated";
  requiresTranslation: boolean;
  requiresExtraction: boolean;
}> {
  // Same input the translation hash is computed from everywhere (title+content+target).
  const hash = computeTranslationHash(title, content, translation?.targetLanguage ?? "");
  if (existingUrls.has(url)) {
    const existing = existingTranslations.get(url);
    const existingExtraction = existingExtractions?.get(url);
    await prisma.feedItem.update({
      where: { sourceId_url: { sourceId, url } },
      // title/content always carry the ORIGINAL article text — translation never
      // writes here (v2-4). Nor does extraction: `content` stays the raw scrape.
      data: {
        title,
        content,
        publishedAt,
        // Written only when this run actually found one. A publisher outage, a
        // paywall, or a redesign that drops the og:image must not erase an image
        // a post may already be using — the stored value stands until a run
        // resolves a better one.
        ...(sourceImageUrl ? { sourceImageUrl } : {}),
        ...translationFieldsForUpdate(translation, hash, existing),
        ...extractionFieldsFor(extractionHash, existingExtraction),
      },
    });
    return {
      outcome: "updated",
      requiresTranslation: requiresTranslationWork(translation, hash, false, existing),
      requiresExtraction: requiresExtractionWork(extractionHash, existingExtraction),
    };
  } else {
    await prisma.feedItem.create({
      data: {
        sourceId,
        companyId,
        url,
        title,
        content,
        publishedAt,
        sourceImageUrl,
        ...translationFieldsForCreate(translation),
        ...extractionFieldsFor(extractionHash, undefined),
      },
    });
    existingUrls.add(url);
    return {
      outcome: "created",
      requiresTranslation: requiresTranslationWork(translation, hash, true, undefined),
      requiresExtraction: requiresExtractionWork(extractionHash, undefined),
    };
  }
}

/** The subset of a ContentSource row the ingestion core needs. */
export interface IngestableSource {
  id: string;
  type: string;
  name: string;
  config: unknown;
}

export interface RunSourceIngestionOptions {
  /**
   * Consulted before each RSS item's (slow) article extraction. Return true to
   * stop processing further items this run and leave the rest for the next one —
   * how the batched cron keeps a single large feed from overrunning the Vercel
   * function limit. Omitted = process the whole feed (the original behavior).
   * Deduplication is unaffected: unprocessed items are simply picked up next run
   * and upserted by URL as before.
   */
  shouldStop?: () => boolean;
}

/**
 * System-level ingestion core — no RBAC. Fetches the source, upserts feed
 * items, and stamps lastFetchedAt. Throws on fetch/parse failure.
 * Used by both the user-triggered service below and the cron dispatcher.
 */
export async function runSourceIngestion(
  source: IngestableSource,
  companyId: string,
  options?: RunSourceIngestionOptions
): Promise<{
  created: number;
  updated: number;
  translationWorkCreated: number;
  extractionWorkCreated: number;
}> {
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
    select: {
      url: true,
      translationHash: true,
      translationStatus: true,
      translationAttemptCount: true,
      extractionHash: true,
      extractionStatus: true,
    },
  });
  const existingUrls = new Set(existingRows.map((r) => r.url));
  const existingTranslations = new Map<string, ExistingTranslation>(
    existingRows.map((r) => [
      r.url,
      {
        translationHash: r.translationHash,
        translationStatus: r.translationStatus,
        translationAttemptCount: r.translationAttemptCount,
      },
    ])
  );
  const existingExtractions = new Map<string, ExistingExtraction>(
    existingRows.map((r) => [
      r.url,
      { extractionHash: r.extractionHash, extractionStatus: r.extractionStatus },
    ])
  );

  let created = 0;
  let updated = 0;
  // Feed items this run left genuinely needing translation — the precise signal (not
  // created/updated) the manual ingest route uses to enqueue translation.
  let translationWorkCreated = 0;
  // The same signal for product-page extraction: an item whose page text or
  // instruction changed (or which has never been extracted) needs a model call,
  // and a re-scrape that produced identical input does not.
  let extractionWorkCreated = 0;

  if (source.type === "rss") {
    const items = await parseFeed(config.url);
    // A feed can legitimately surface the same resolved URL more than once in a
    // single fetch. Each URL maps to one row, so process it once — otherwise a
    // repeated URL would upsert twice and be miscounted as an "update".
    const processed = new Set<string>();
    for (const item of items) {
      // Out of time for this run — stop before starting another slow extraction.
      // lastFetchedAt is still stamped below, so the remaining items are refetched
      // (and deduped by URL) on a later run rather than lost.
      if (options?.shouldStop?.()) break;
      if (!item.url) continue;
      if (processed.has(item.url)) continue;
      processed.add(item.url);
      const extracted = await extractArticle(item.url);
      const content = extracted.text ?? item.summary;
      // Each candidate has already been filtered for icons, avatars and
      // tracking pixels; pickSourceImage only chooses between them.
      const sourceImageUrl = pickSourceImage({
        metaImageUrl: extracted.metaImageUrl,
        feedImageUrl: item.imageUrl,
        contentImageUrl: extracted.contentImageUrl,
      });
      const { outcome, requiresTranslation } = await upsertFeedItem(
        sourceId,
        companyId,
        item.url,
        item.title,
        content,
        item.publishedAt,
        existingUrls,
        translation,
        existingTranslations,
        sourceImageUrl
      );
      if (outcome === "created") created++;
      else updated++;
      if (requiresTranslation) translationWorkCreated++;
    }
  } else if (source.type === "product_page") {
    // What the owner asked to be taken from this page, when they said anything.
    // Its presence is what turns on body-text extraction: a listing page's
    // og:description never contains the list the instruction points at, and a
    // source without an instruction must keep behaving exactly as before.
    const instructions = extractionInstructionsOf(source.config);
    const meta = await scrapeProductPage(config.url, { includeText: instructions !== null });
    const content = JSON.stringify({
      title: meta.ogTitle ?? meta.title,
      description: meta.ogDescription ?? meta.description,
      image: meta.ogImage,
      // The RAW page, stored with the item and never overwritten by the
      // extraction step that runs later. It is the input a stored result was
      // derived from, which is what makes a wrong extraction diagnosable — and
      // what lets a re-run start from the page rather than from its own last
      // answer.
      ...(instructions ? { instructions, pageText: meta.pageText } : {}),
    });
    const { outcome, requiresTranslation, requiresExtraction } = await upsertFeedItem(
      sourceId,
      companyId,
      config.url,
      meta.ogTitle ?? meta.title,
      content,
      null,
      existingUrls,
      translation,
      existingTranslations,
      null,
      instructions ? computeExtractionHash(meta.pageText, instructions) : null,
      existingExtractions
    );
    if (outcome === "created") created++;
    else updated++;
    if (requiresTranslation) translationWorkCreated++;
    if (requiresExtraction) extractionWorkCreated++;
  } else if (source.type === "prompt") {
    const stableUrl = `prompt:${sourceId}`;
    const { outcome, requiresTranslation } = await upsertFeedItem(
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
    if (requiresTranslation) translationWorkCreated++;
  } else if (source.type === "calendar_event") {
    const stableUrl = `event:${sourceId}`;
    const content = JSON.stringify({
      title: config.title,
      date: config.date,
      description: config.description ?? null,
    });
    const publishedAt = config.date ? new Date(config.date) : null;
    const { outcome, requiresTranslation } = await upsertFeedItem(
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
    if (requiresTranslation) translationWorkCreated++;
  }

  await prisma.contentSource.update({
    where: { id: sourceId },
    data: { lastFetchedAt: new Date() },
  });

  return { created, updated, translationWorkCreated, extractionWorkCreated };
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
    const { created, updated, translationWorkCreated, extractionWorkCreated } =
      await runSourceIngestion(source, companyId);
    return { success: true, created, updated, translationWorkCreated, extractionWorkCreated };
  } catch (err) {
    return {
      success: false,
      code: "INGEST_FAILED",
      message: err instanceof Error ? err.message : "Unknown error during ingestion.",
    };
  }
}
