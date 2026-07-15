/**
 * FeedItem reservation (Phase 0 — one-post-per-article).
 *
 * A generated post consumes exactly one source article (its primary feed item),
 * and an article is never used twice. Two guarantees enforce this:
 *
 *   1. An atomic conditional UPDATE claims the item *before* the LLM call, so a
 *      concurrent cron invocation (or the next iteration of the same run) cannot
 *      pick the same article. This is the same lock-free pattern used for the
 *      WeeklySchedule pending→generating transition — no advisory locks, safe on
 *      serverless.
 *   2. A DB-level unique index on Post.primaryFeedItemId is the correctness
 *      backstop: even if the boolean claim raced, the second post insert fails.
 *
 * These functions are deliberately provider-agnostic and take an injectable db
 * so they can be unit-tested without a live database (see the .test.ts file).
 */

export interface FeedItemReservationDb {
  feedItem: {
    updateMany: (args: {
      where: { id: string; usedInPost: boolean };
      data: { usedInPost: boolean };
    }) => Promise<{ count: number }>;
  };
}

/**
 * Atomically claims the first claimable candidate from `candidateIds`, in order.
 *
 * Each attempt is a conditional `UPDATE ... WHERE id = ? AND used_in_post = false`.
 * Postgres guarantees at most one concurrent transaction can flip the row, so a
 * `count` of 1 means we own it; a `count` of 0 means it was already used (either
 * previously, or just claimed by a concurrent run) — we move to the next
 * candidate.
 *
 * Returns the claimed feed item id, or null when every candidate is already
 * taken. A null result is NOT an error — the caller should skip cleanly.
 */
export async function claimFeedItem(
  candidateIds: readonly string[],
  db: FeedItemReservationDb
): Promise<string | null> {
  for (const id of candidateIds) {
    const result = await db.feedItem.updateMany({
      where: { id, usedInPost: false },
      data: { usedInPost: true },
    });
    if (result.count === 1) return id;
  }
  return null;
}

/**
 * The decision a generation makes about its source, given the eligible unused
 * *article* candidates, whether the company has any article source at all, and
 * whether an evergreen (prompt/calendar) item is available:
 *
 *   • "mission"   — no sources of any kind; write a mission/brand post
 *   • "skip"      — article sources exist but no unused article can be claimed,
 *                   and no evergreen item is available; skip cleanly
 *   • "generate"  — an article was reserved; generate from it (consumes a claim)
 *   • "evergreen" — no article claimed, but a reusable prompt/calendar item is
 *                   available; generate from it without claiming or consuming
 */
export type FeedItemPlan =
  | { action: "mission" }
  | { action: "skip" }
  | { action: "generate"; feedItemId: string }
  | { action: "evergreen" };

/**
 * Resolves the source decision, claiming an article item when one is available.
 *
 * Article claiming takes priority: if any consumable candidate can be claimed it
 * wins. Otherwise an empty (or fully-raced) article window is disambiguated by
 * whether an evergreen item is present and whether article sources exist:
 *
 *   - article candidates present, claim succeeds → generate from claimed item
 *   - no article claimed, evergreen item present  → evergreen (reuse, no claim)
 *   - no article claimed, article sources exist   → skip (do NOT drift to mission)
 *   - no article claimed, no sources at all       → mission/brand post
 *
 * Only "generate" consumes a claim; "mission", "skip", and "evergreen" touch no
 * rows — evergreen items are deliberately never marked used, so they stay
 * reusable across generations.
 */
export async function planFeedItemUsage(
  articleCandidateIds: readonly string[],
  hasArticleSources: boolean,
  hasEvergreenItems: boolean,
  db: FeedItemReservationDb
): Promise<FeedItemPlan> {
  if (articleCandidateIds.length > 0) {
    const claimed = await claimFeedItem(articleCandidateIds, db);
    if (claimed) return { action: "generate", feedItemId: claimed };
    // Every article candidate was claimed by a concurrent run — fall through to
    // the evergreen / skip / mission decision below.
  }
  if (hasEvergreenItems) return { action: "evergreen" };
  if (hasArticleSources) return { action: "skip" };
  return { action: "mission" };
}

/**
 * Best-effort release of a previously claimed item, used when generation fails
 * before the post is persisted so the article becomes available again.
 *
 * Scoped to `used_in_post = true` so it only ever undoes a live claim; it can
 * never resurrect an item that some other post already committed to.
 */
export async function releaseFeedItem(id: string, db: FeedItemReservationDb): Promise<void> {
  await db.feedItem.updateMany({
    where: { id, usedInPost: true },
    data: { usedInPost: false },
  });
}
