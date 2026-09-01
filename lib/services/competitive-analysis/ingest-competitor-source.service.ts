/**
 * Dedicated competitor RSS ingestion (Part 3B §3). A SEPARATE implementation
 * from `runSourceIngestion` (`lib/services/company/ingest-content-source.service.ts`)
 * — not competitor_rss routed through the normal job with downstream filters
 * trusted to protect it. Low-level fetch/parse primitives are reused
 * (`parseFeed`, `extractArticle`, `resolveArticleContent`, `pickSourceImage`);
 * everything about WHAT gets written is written here, once, and is narrower on
 * purpose:
 *
 *   • Writes ONLY title/content/url/publishedAt/sourceImageUrl and the
 *     content-provenance columns (contentExtraction/contentChars/
 *     contentComplete/contentExtractionError/contentExtractedAt).
 *   • NEVER writes translationStatus, extractionStatus, or classification* —
 *     those columns stay their all-NULL default forever for a competitor
 *     FeedItem, which is what keeps `isClassifiableSourceType` (hard-coded to
 *     "rss" only) and the translation/extraction drains — which SELECT on
 *     those status columns being non-null — from ever picking one up, even by
 *     accident (§4/§8's isolation requirement, defense in depth beyond the
 *     source-type check alone).
 *   • Idempotently OPENS one pending `CompetitorIntelligence` row per new
 *     `FeedItem` via `upsert` (never a bare `create`) — see the verification
 *     pass note below.
 *
 * ── SSRF/fetch safety ────────────────────────────────────────────────────
 * Both `parseFeed` (`lib/integrations/rss/parser.ts`) and `extractArticle`
 * (`lib/integrations/rss/article-extractor.ts`) now route every fetch —
 * feed URL, article URL, AND every redirect hop either one issues — through
 * `safeFetch`, which independently re-validates each hop with `checkSsrf`
 * before requesting it (see `safeFetch`'s own doc comment for why automatic
 * redirect-following was unsafe here). That fix lives in the shared,
 * low-level fetch layer, so it protects the normal RSS pipeline identically
 * — this module's own `checkSsrf(feedUrl)` call below is now a redundant,
 * fast-fail pre-check kept deliberately: it rejects an obviously-unsafe
 * competitor feed URL with a specific, typed error
 * (`CompetitorFeedSsrfBlockedError`) before even constructing the `parseFeed`
 * call, rather than relying solely on the shared layer's more generic
 * `FeedFetchBlockedError`. A competitor feed URL is meaningfully MORE exposed
 * than an owner's own RSS source (it is explicitly framed as "paste a URL to
 * watch", inviting less scrutiny), which is why this module keeps the extra
 * layer rather than trusting the shared guard alone.
 */

import { prisma } from "@/lib/db/client";
import { parseFeed } from "@/lib/integrations/rss/parser";
import {
  extractArticle,
  resolveArticleContent,
  checkSsrf,
} from "@/lib/integrations/rss/article-extractor";
import { pickSourceImage } from "@/lib/integrations/rss/article-image";
import { resolveCompetitiveAnalysisContext } from "./resolve-competitor-context";

export type IngestCompetitorSourceResult =
  | { success: true; created: number; updated: number }
  | {
      success: false;
      code: "NOT_FOUND" | "FORBIDDEN" | "ARCHIVED" | "INGEST_FAILED";
      message?: string;
    };

/** The subset of a competitor ContentSource row ingestion needs. */
export interface IngestableCompetitorSource {
  id: string;
  config: unknown;
}

export class CompetitorFeedSsrfBlockedError extends Error {
  constructor(url: string) {
    super(`Refused to fetch feed URL "${url}" — blocked by SSRF protection.`);
    this.name = "CompetitorFeedSsrfBlockedError";
  }
}

/**
 * System-level ingestion core — no RBAC. Fetches the feed, upserts `FeedItem`
 * rows scoped to this competitor's source, and stamps `lastFetchedAt`. Throws
 * on fetch/parse failure (including an SSRF-blocked feed URL), exactly like
 * `runSourceIngestion`.
 *
 * Deliberately does NOT re-check `archivedAt` itself — see
 * `ingestCompetitorSource` below for the two-checkpoint rule (§14): the
 * caller re-verifies immediately before invoking this function, which is the
 * checkpoint that matters, since this is where the network fetch actually
 * starts. A future cron sweep calling this directly is equally responsible
 * for its own immediately-before check.
 */
export async function runCompetitorSourceIngestion(
  source: IngestableCompetitorSource,
  companyId: string,
  competitorId: string
): Promise<{ created: number; updated: number }> {
  const config = source.config as Record<string, string>;

  let feedUrl: URL;
  try {
    feedUrl = new URL(config.url);
  } catch {
    throw new Error(`Invalid feed URL: ${config.url}`);
  }
  if (!(await checkSsrf(feedUrl))) {
    throw new CompetitorFeedSsrfBlockedError(config.url);
  }

  const items = await parseFeed(config.url);

  const existingRows = await prisma.feedItem.findMany({
    where: { sourceId: source.id },
    select: { id: true, url: true },
  });
  const existingByUrl = new Map(existingRows.map((r) => [r.url, r.id]));

  let created = 0;
  let updated = 0;
  const processed = new Set<string>();

  for (const item of items) {
    if (!item.url || processed.has(item.url)) continue;
    processed.add(item.url);

    // `extractArticle` applies its OWN SSRF check to this per-item URL, the
    // same guard the normal RSS pipeline already relies on — see the module
    // comment.
    const extracted = await extractArticle(item.url);
    const article = resolveArticleContent(extracted, item.summary);
    const sourceImageUrl = pickSourceImage({
      metaImageUrl: extracted.metaImageUrl,
      feedImageUrl: item.imageUrl,
      contentImageUrl: extracted.contentImageUrl,
    });

    const provenance = {
      contentExtraction: article.method,
      contentChars: article.chars,
      contentComplete: article.complete,
      contentExtractionError: article.error,
      contentExtractedAt: new Date(),
    };

    const existingId = existingByUrl.get(item.url);
    if (existingId) {
      await prisma.feedItem.update({
        where: { id: existingId },
        data: {
          title: item.title,
          content: article.content,
          publishedAt: item.publishedAt,
          ...(sourceImageUrl ? { sourceImageUrl } : {}),
          ...provenance,
        },
      });
      updated++;
    } else {
      const row = await prisma.feedItem.create({
        data: {
          sourceId: source.id,
          companyId,
          url: item.url,
          title: item.title,
          content: article.content,
          publishedAt: item.publishedAt,
          sourceImageUrl,
          ...provenance,
          // translationStatus/extractionStatus/classificationStatus all stay
          // their column default (NULL) — see the module comment.
        },
        select: { id: true },
      });
      existingByUrl.set(item.url, row.id);
      created++;

      // Idempotent open of the extraction drain's claimable unit — an
      // UPSERT, not a bare `create` (verification pass §3). `feedItemId` is
      // unique, so a concurrent/retried ingestion of the SAME new URL (e.g. a
      // double "Sync" click racing on the same not-yet-committed row) would
      // otherwise throw, and a bare create wrapped in try/catch would
      // silently swallow that AND any genuine, unrelated failure alike. The
      // `update: {}` is a deliberate no-op: an already-existing row (pending,
      // analyzing, or completed) must never be reset by a later ingest of the
      // same item.
      await prisma.competitorIntelligence.upsert({
        where: { feedItemId: row.id },
        create: { companyId, competitorId, feedItemId: row.id, status: "pending" },
        update: {},
      });
    }
  }

  await prisma.contentSource.update({
    where: { id: source.id },
    data: { lastFetchedAt: new Date() },
  });

  return { created, updated };
}

/**
 * User-triggered ingestion — the "Sync" action (§19). Owner-only, same bar as
 * managing the source itself.
 *
 * Archive guard, TWO checkpoints (§5/§14 — verification pass corrected this):
 *   1. right after resolving the competitor, before even looking up the
 *      source row;
 *   2. a SECOND, freshly-read check immediately before invoking
 *      `runCompetitorSourceIngestion` — the call that actually starts the
 *      network fetch. The source lookup between the two is itself a small
 *      window during which the competitor could be archived; re-reading here
 *      (rather than trusting checkpoint 1) is what makes this genuinely
 *      "immediately before the fetch" rather than merely "before the fetch,
 *      with a lookup in between."
 */
export async function ingestCompetitorSource(
  slug: string,
  competitorId: string,
  sourceId: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<IngestCompetitorSourceResult> {
  const resolved = await resolveCompetitiveAnalysisContext(slug, userId, isGlobalAdmin, true);
  if (!resolved.ok) return { success: false, code: resolved.code };
  const { companyId } = resolved.context;

  const competitor = await prisma.competitor.findFirst({
    where: { id: competitorId, companyId },
    select: { archivedAt: true },
  });
  if (!competitor) return { success: false, code: "NOT_FOUND" };
  if (competitor.archivedAt) return { success: false, code: "ARCHIVED" };

  const source = await prisma.contentSource.findFirst({
    where: { id: sourceId, competitorId, companyId, type: "competitor_rss" },
    select: { id: true, config: true },
  });
  if (!source) return { success: false, code: "NOT_FOUND" };

  // Checkpoint 2 — freshly re-read, immediately before the fetch.
  const stillActive = await prisma.competitor.findFirst({
    where: { id: competitorId, companyId },
    select: { archivedAt: true },
  });
  if (!stillActive || stillActive.archivedAt) return { success: false, code: "ARCHIVED" };

  try {
    const { created, updated } = await runCompetitorSourceIngestion(
      source,
      companyId,
      competitorId
    );
    return { success: true, created, updated };
  } catch (err) {
    return {
      success: false,
      code: "INGEST_FAILED",
      message: err instanceof Error ? err.message : "Unknown error during ingestion.",
    };
  }
}
