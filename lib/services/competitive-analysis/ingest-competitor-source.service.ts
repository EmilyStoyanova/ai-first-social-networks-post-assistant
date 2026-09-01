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
 * ── 2026-09 content-acquisition fix ─────────────────────────────────────────
 * A follow-up incident to the livelock fix above: with the livelock gone, the
 * worker terminated correctly but reported `extracted: 0` — every real row
 * was skipped `missing_content`. Root cause, confirmed against the real feed
 * (`medium.com/feed/...`): the article page 403'd (Medium blocks
 * unauthenticated reads) AND the feed shipped its full article body ONLY in
 * `<content:encoded>`, which `parser.ts`'s summary chain silently failed to
 * read (see `extractContentEncoded`'s doc comment) — so `resolveArticleContent`
 * had no fallback left and stored `content: null`. Two changes fix this:
 *   1. `resolveArticleContent` now also receives `item.fullContent`
 *      (`<content:encoded>`) and prefers it over the bare summary — see that
 *      function's doc comment for the full hierarchy.
 *   2. This function no longer unconditionally overwrites a `FeedItem`'s
 *      `content`/provenance on re-ingest. `contentQualityRank` compares what
 *      this run resolved against what is already stored, and a later run
 *      that can only produce a WORSE tier (e.g. the site started blocking
 *      reads) no longer erases a better answer already on file.
 *   3. When content genuinely changes for a `failed` or `completed`
 *      `CompetitorIntelligence` row (most relevantly: a `missing_content`
 *      failure that exhausted its attempts, now that content is available),
 *      the row is reopened — `status: "pending"`, attempt budget reset — so
 *      it becomes eligible for analysis again without any manual DB edit.
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
  contentQualityRank,
} from "@/lib/integrations/rss/article-extractor";
import type { ExtractionMethod } from "@/lib/integrations/rss/article-strategies";
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
 * Whether a re-ingest should overwrite a `FeedItem`'s stored `content` and
 * provenance columns — 2026-09 content-acquisition fix (see this file's
 * module comment). Pure and exported so "a better article never gets
 * overwritten by a weaker summary" is directly testable without a database:
 * `>=` rather than `>` is deliberate — a same-tier re-read (the article
 * changed but is still, say, `rss_summary`) is a legitimate update, only a
 * genuine DOWNGRADE is refused.
 */
export function shouldOverwriteFeedItemContent(
  existing: { contentExtraction: ExtractionMethod | null; contentComplete: boolean | null },
  incoming: { method: ExtractionMethod | null; complete: boolean }
): boolean {
  return (
    contentQualityRank(incoming.method, incoming.complete) >=
    contentQualityRank(existing.contentExtraction, existing.contentComplete ?? false)
  );
}

/**
 * Whether a `CompetitorIntelligence` row's content genuinely changed this
 * ingest — the signal that reopens a `failed`/`completed` row for analysis
 * (2026-09 content-acquisition fix, see this file's module comment). Pure and
 * exported for the same reason as `shouldOverwriteFeedItemContent`: this is
 * the exact rule that lets a `missing_content` failure recover once real
 * content shows up, without resetting a row whose content didn't actually
 * move (a no-op re-ingest of a still-blocked page, or an already-completed
 * row re-read identically).
 */
export function feedItemContentChanged(
  existingContent: string | null,
  incomingContent: string | null
): boolean {
  return incomingContent !== null && incomingContent !== existingContent;
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
    select: {
      id: true,
      url: true,
      content: true,
      contentExtraction: true,
      contentComplete: true,
    },
  });
  const existingByUrl = new Map(existingRows.map((r) => [r.url, r]));

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
    const article = resolveArticleContent(extracted, item.summary, item.fullContent);
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

    const existing = existingByUrl.get(item.url);
    if (existing) {
      // Never let a re-ingest downgrade what is already on file, and reopen a
      // settled CompetitorIntelligence row when content genuinely changed —
      // 2026-09 fix, see the module comment and each function's doc comment.
      const shouldOverwriteContent = shouldOverwriteFeedItemContent(
        {
          contentExtraction: existing.contentExtraction as ExtractionMethod | null,
          contentComplete: existing.contentComplete,
        },
        { method: article.method, complete: article.complete }
      );
      const contentChanged = feedItemContentChanged(existing.content, article.content);

      await prisma.feedItem.update({
        where: { id: existing.id },
        data: {
          title: item.title,
          publishedAt: item.publishedAt,
          ...(sourceImageUrl ? { sourceImageUrl } : {}),
          ...(shouldOverwriteContent ? { content: article.content, ...provenance } : {}),
        },
      });
      updated++;

      if (contentChanged) {
        // Guarded to `failed`/`completed` only — a `pending` row is already
        // eligible, and an `analyzing` row is mid-flight under another run's
        // lease and must not be stomped here.
        await prisma.competitorIntelligence.updateMany({
          where: { feedItemId: existing.id, status: { in: ["failed", "completed"] } },
          data: {
            status: "pending",
            attemptCount: 0,
            analysisError: null,
            analysisHash: null,
            analyzedAt: null,
            leaseExpiresAt: null,
          },
        });
      }
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
      existingByUrl.set(item.url, {
        id: row.id,
        url: item.url,
        content: article.content,
        contentExtraction: article.method,
        contentComplete: article.complete,
      });
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
