/**
 * Pure mirror of the migration's `competitor_intelligence_exactly_one_origin`
 * CHECK constraint (`num_nonnulls(feed_item_id, manual_entry_id,
 * social_item_id) = 1`) — kept here so the constraint's LOGIC is
 * unit-testable without a live Postgres connection (this repo has no DB test
 * harness). This does NOT substitute for the real DB constraint; it verifies
 * the SQL expression's intended behavior ahead of ever applying it.
 *
 * No service in Part 3A constructs a `CompetitorIntelligence` row — this
 * exists purely to pin the exactly-one-of-three invariant now, before the
 * extraction pipeline (Part 3B) or social sync (Part 3C) ever writes one.
 */
export interface CompetitorIntelligenceOrigin {
  feedItemId: string | null;
  manualEntryId: string | null;
  socialItemId: string | null;
}

export function hasExactlyOneOrigin(origin: CompetitorIntelligenceOrigin): boolean {
  const nonNullCount = [origin.feedItemId, origin.manualEntryId, origin.socialItemId].filter(
    (v) => v !== null
  ).length;
  return nonNullCount === 1;
}
