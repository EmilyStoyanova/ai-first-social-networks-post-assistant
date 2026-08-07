/**
 * Where a generated post came from.
 *
 *   • source      — written from a specific article, drawn from a content
 *                   source. Carries the source's kind and name, and the article.
 *   • brand_setup — written from the company's own mission/brand knowledge with
 *                   no article behind it. Covers BOTH manual choices that end
 *                   there: "Company Mission", and "Company rules" on a company
 *                   with no article available.
 *
 * Recorded from what the generation actually did, not from which dropdown value
 * was picked. Those differ — picking "Company rules" with an empty article pool
 * produces a mission post, and reporting the pick would label it with a source
 * it never used.
 */

import { hasPublicUrl, publicUrlOf } from "@/lib/ai/source-types";

/** Mirrors Prisma's ContentSourceType. Duplicated so client components that
 *  render an origin need not pull in the Prisma client. */
export type OriginSourceType = "rss" | "prompt" | "product_page" | "calendar_event";

export interface PostOriginView {
  kind: "brand_setup" | "source";
  /**
   * The KIND of source — what makes the badge read "RSS · TechPowerUp" rather
   * than a bare name. Null on a brand_setup post, and on a source post whose
   * type was never captured (see the snapshot notes below).
   */
  sourceType: OriginSourceType | null;
  /** Content source name. Null when the source was never recorded. */
  sourceName: string | null;
  /** Article headline; null for an article that was ingested without one. */
  articleTitle: string | null;
  /**
   * A real, openable page for the source — rendered as a link. Null for
   * brand_setup, and for any source with no public address of its own (a prompt
   * source; a calendar event with no Event URL). Never a `prompt:`/`event:`
   * storage key, whatever an older row happens to hold.
   */
  articleUrl: string | null;
}

/** The joined article, exactly as the post queries select it. */
export interface PrimaryFeedItemRow {
  title: string | null;
  url: string;
  source: { name: string; type: string };
}

/**
 * The immutable origin columns on the post row, copied in at generation time.
 * `originType` is null only for posts generated before the columns existed.
 *
 * `originSourceType` can be null on a source post even when the rest is set: it
 * arrived one migration after the others, and a post whose article was already
 * gone by then could not have its type recovered. The name and URL still stand,
 * so such a post renders its name alone.
 */
export interface PostOriginSnapshot {
  originType: "brand_setup" | "content_source" | null;
  originSourceType: OriginSourceType | null;
  originSourceName: string | null;
  originSourceTitle: string | null;
  originSourceUrl: string | null;
}

const SOURCE_TYPES: readonly string[] = ["rss", "prompt", "product_page", "calendar_event"];

/** Narrows a stored/joined type string, so an unknown value degrades to null
 *  rather than reaching the UI as a missing translation key. */
export function toOriginSourceType(value: string | null | undefined): OriginSourceType | null {
  return value && SOURCE_TYPES.includes(value) ? (value as OriginSourceType) : null;
}

function brandSetup(): PostOriginView {
  return {
    kind: "brand_setup",
    sourceType: null,
    sourceName: null,
    articleTitle: null,
    articleUrl: null,
  };
}

/**
 * Resolves a post's origin, preferring the frozen snapshot on the post row.
 *
 * The snapshot is authoritative because it is the only account that cannot
 * change after the fact. The live relations can: deleting a content source
 * cascades to its feed items, nulling `Post.primaryFeedItemId` on every post
 * written from it, and renaming a source would relabel posts published under
 * the old name.
 *
 * The relations are consulted only when `originType` is null — a post generated
 * before the snapshot columns existed and not reached by the migration's
 * backfill. Those are the sole posts whose displayed origin can still shift, and
 * only in the direction the app already had before this change.
 */
export function resolvePostOrigin(
  snapshot: PostOriginSnapshot | null,
  primaryFeedItem: PrimaryFeedItemRow | null
): PostOriginView {
  if (snapshot?.originType === "brand_setup") return brandSetup();

  if (snapshot?.originType === "content_source") {
    return {
      kind: "source",
      sourceType: toOriginSourceType(snapshot.originSourceType),
      sourceName: snapshot.originSourceName,
      // An article ingested without a headline still has a URL, which is enough
      // to point at it — the title is what degrades, not the link.
      articleTitle: snapshot.originSourceTitle,
      // Filtered on the way out, not only on the way in: posts written before
      // the Event URL existed froze `event:<id>` into this column, and the UI
      // renders it as an href. One guard here covers every historical row with
      // no backfill.
      articleUrl: hasPublicUrl(snapshot.originSourceUrl) ? snapshot.originSourceUrl : null,
    };
  }

  // ── Legacy fallback (originType IS NULL) ──────────────────────────────────
  if (!primaryFeedItem) return brandSetup();

  return {
    kind: "source",
    sourceType: toOriginSourceType(primaryFeedItem.source.type),
    sourceName: primaryFeedItem.source.name,
    articleTitle: primaryFeedItem.title,
    articleUrl: hasPublicUrl(primaryFeedItem.url) ? primaryFeedItem.url : null,
  };
}

/** The origin of a post generated from the company's own brand knowledge. */
export function brandSetupOrigin(): PostOriginView {
  return brandSetup();
}

/** The article a post was built on, as the generation context knows it. */
export interface GeneratedFromArticle {
  title: string | null;
  url: string;
  /**
   * The item's public address, when it differs from `url` — a calendar event's
   * Event URL. Undefined on a context assembled before the field existed, which
   * `publicUrlOf` resolves from `url` instead.
   */
  publicUrl?: string | null;
  /** Undefined on a context assembled before FeedItemContext carried these. */
  sourceType?: string | null;
  sourceName?: string | null;
}

/**
 * Builds the columns to write at generation time from the article the post was
 * actually built on. Pass null for a mission/brand post.
 *
 * Takes the article rather than the dropdown selection on purpose: choosing
 * "Company rules" with an empty article pool produces a mission post, and
 * recording the choice would stamp it with a source it never read.
 */
export function buildOriginSnapshot(article: GeneratedFromArticle | null): PostOriginSnapshot {
  if (!article) {
    return {
      originType: "brand_setup",
      originSourceType: null,
      originSourceName: null,
      originSourceTitle: null,
      originSourceUrl: null,
    };
  }

  return {
    originType: "content_source",
    // A source post with an unknown kind or name still beats no origin at all —
    // the badge simply shows less.
    originSourceType: toOriginSourceType(article.sourceType),
    originSourceName: article.sourceName ?? null,
    originSourceTitle: article.title,
    // The public address or nothing. Freezing a `prompt:`/`event:` key here is
    // what put a dead link in the post activity modal; the column is for a page
    // a reader can open, and a source without one simply has no link.
    originSourceUrl: publicUrlOf(article),
  };
}
