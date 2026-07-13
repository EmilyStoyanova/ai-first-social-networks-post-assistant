import type { FeedItemContext } from "./types";

/**
 * Selects the single primary feed item a generated post must be based on.
 *
 * Feed items arrive newest-first from the context builder, but this selection is
 * deliberately positional (not date-based): whichever item is returned here is
 * the ONE the prompt is built around AND the one whose URL is appended as the
 * source link. Both the prompt builder and the post service call this function,
 * so the generated post text and the appended source URL can never refer to
 * different articles.
 *
 * Returns null when there are no feed items.
 */
export function selectPrimaryFeedItem(
  feedItems: readonly FeedItemContext[]
): FeedItemContext | null {
  return feedItems[0] ?? null;
}
