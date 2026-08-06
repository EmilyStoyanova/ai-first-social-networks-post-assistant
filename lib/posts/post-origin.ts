/**
 * Where a generated post came from.
 *
 *   • source      — written from a specific article, drawn from a content
 *                   source. Carries the feed name and the article itself.
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
export interface PostOriginView {
  kind: "brand_setup" | "source";
  /** Content source name. Null when the source was never recorded (see below). */
  sourceName: string | null;
  /** Article headline; null for an article that was ingested without one. */
  articleTitle: string | null;
  /** Article URL — present for a source post, absent for brand_setup. */
  articleUrl: string | null;
}

/** The joined article, exactly as the post queries select it. */
export interface PrimaryFeedItemRow {
  title: string | null;
  url: string;
  source: { name: string };
}

/**
 * The immutable origin columns on the post row, copied in at generation time.
 * `originType` is null only for posts generated before the column existed.
 */
export interface PostOriginSnapshot {
  originType: "brand_setup" | "content_source" | null;
  originSourceName: string | null;
  originSourceTitle: string | null;
  originSourceUrl: string | null;
}

function brandSetup(): PostOriginView {
  return { kind: "brand_setup", sourceName: null, articleTitle: null, articleUrl: null };
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
      sourceName: snapshot.originSourceName,
      // An article ingested without a headline still has a URL, which is enough
      // to point at it — the title is what degrades, not the link.
      articleTitle: snapshot.originSourceTitle,
      articleUrl: snapshot.originSourceUrl,
    };
  }

  // ── Legacy fallback (originType IS NULL) ──────────────────────────────────
  if (!primaryFeedItem) return brandSetup();

  return {
    kind: "source",
    sourceName: primaryFeedItem.source.name,
    articleTitle: primaryFeedItem.title,
    articleUrl: primaryFeedItem.url,
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
  /** Undefined on a context assembled before FeedItemContext carried the name. */
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
      originSourceName: null,
      originSourceTitle: null,
      originSourceUrl: null,
    };
  }

  return {
    originType: "content_source",
    // A source post with an unknown name still beats no origin at all — the UI
    // falls back to a generic "Content source" label.
    originSourceName: article.sourceName ?? null,
    originSourceTitle: article.title,
    originSourceUrl: article.url,
  };
}
