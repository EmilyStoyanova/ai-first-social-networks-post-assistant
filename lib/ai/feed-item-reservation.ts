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
 * The decision a generation makes about its source article, given the eligible
 * unused candidates and whether the company has any RSS configured at all.
 *
 *   • "mission"  — no content sources; write a mission/brand post (no article)
 *   • "skip"     — sources exist but no article can be claimed; skip cleanly
 *   • "generate" — an article was reserved; generate from it
 */
export type FeedItemPlan =
  { action: "mission" } | { action: "skip" } | { action: "generate"; feedItemId: string };

/**
 * Resolves the three-way source-article decision, claiming an item when one is
 * available. An empty candidate window is ambiguous on its own — it means either
 * "no RSS configured" or "RSS configured but every article is already used" — so
 * `hasContentSources` disambiguates:
 *
 *   - candidates present, claim succeeds → generate from the claimed item
 *   - candidates present, all raced away → skip (nothing left to claim)
 *   - no candidates, sources exist       → skip (do NOT drift to a mission post)
 *   - no candidates, no sources          → mission/brand post
 *
 * Only "generate" consumes a claim; "mission" and "skip" touch no rows.
 */
export async function planFeedItemUsage(
  candidateIds: readonly string[],
  hasContentSources: boolean,
  db: FeedItemReservationDb
): Promise<FeedItemPlan> {
  if (candidateIds.length === 0) {
    return hasContentSources ? { action: "skip" } : { action: "mission" };
  }
  const claimed = await claimFeedItem(candidateIds, db);
  if (!claimed) return { action: "skip" };
  return { action: "generate", feedItemId: claimed };
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
