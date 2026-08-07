import type { FeedItemContext } from "./types";
import { isConsumableItem, publicUrlOf } from "./source-types";
import type { FeedItemPlan } from "./feed-item-reservation";

/**
 * The ONE article a generated post is built around, resolved exactly once.
 *
 * Everything downstream — the prompt's PRIMARY SOURCE block, the mined content
 * aspects, `Post.primaryFeedItemId`, the appended source URL, and the
 * promptSnapshot — reads this object. Nothing re-derives the primary from
 * `feedItems`, an array index, or a fresh query, because every independent
 * derivation is a chance for two of them to disagree about which article the
 * post is about.
 *
 * The fields are redundant on purpose: holding the id and the URL alongside the
 * item is what makes `sourceUrl === item.url` and
 * `Post.primaryFeedItemId === item.id` true by construction rather than by
 * convention.
 */
export interface PrimarySelection {
  /**
   * The item the post is written from — the only source of its subject matter.
   * Null for a mission/brand post, which has no article behind it.
   */
  item: FeedItemContext | null;
  /**
   * The reserved article's id, written to `Post.primaryFeedItemId`. Null for
   * evergreen and mission posts: they consume nothing and claim nothing.
   */
  claimedFeedItemId: string | null;
  /**
   * The URL to append to the post — always a real page, never the synthetic
   * `prompt:<id>` / `event:<id>` storage key. Null when the primary has no
   * public address at all: a prompt source, or a calendar event whose optional
   * Event URL was left blank.
   */
  sourceUrl: string | null;
}

const NO_PRIMARY: PrimarySelection = { item: null, claimedFeedItemId: null, sourceUrl: null };

/**
 * Resolves the primary from the reservation plan — the single point where "which
 * article is this post about" is decided.
 *
 * Driven by the plan rather than by position: the claimed article is whichever
 * one the atomic reservation actually won, which is not necessarily the first
 * candidate (a concurrent run may have taken that one). Selecting positionally
 * would silently disagree with the row we hold the claim on.
 */
export function resolvePrimarySelection(
  feedItems: readonly FeedItemContext[],
  plan: FeedItemPlan
): PrimarySelection {
  if (plan.action === "generate") {
    const item = feedItems.find((f) => f.id === plan.feedItemId);
    if (!item) {
      // Impossible by construction — the plan's id came from these same items.
      // Loud rather than silent: continuing would write a post whose text and
      // reserved article are unrelated, which is the exact failure this module
      // exists to prevent.
      throw new Error(
        `Claimed feed item ${plan.feedItemId} is not present in the generation context.`
      );
    }
    return {
      item,
      claimedFeedItemId: item.id,
      // A claimed item is always consumable (candidates are filtered on it), so
      // this is defence in depth rather than a real branch.
      sourceUrl: isConsumableItem(item) ? publicUrlOf(item) : null,
    };
  }

  if (plan.action === "direct") {
    // A manually picked non-RSS source, read from its stored extraction. The
    // window is already restricted to that one source and ordered newest-first,
    // so the first item IS its latest extracted content.
    //
    // Nothing is claimed — claimedFeedItemId stays null, and so does
    // Post.primaryFeedItemId — but the URL is kept when the source has a real
    // page: a product page always does, and a calendar event does when its
    // optional Event URL is set.
    const item = feedItems[0] ?? null;
    return {
      item,
      claimedFeedItemId: null,
      sourceUrl: item ? publicUrlOf(item) : null,
    };
  }

  if (plan.action === "evergreen") {
    // Reusable prompt/calendar content. Articles are excluded entirely: one may
    // have been claimable when the context was built and raced away since, and
    // it must not become the subject of a post it no longer backs.
    //
    // Linkable by the same rule as everywhere else, which for these types means
    // only a calendar event carrying an Event URL — a prompt source has no page.
    const item = feedItems.find((f) => !isConsumableItem(f)) ?? null;
    return { item, claimedFeedItemId: null, sourceUrl: item ? publicUrlOf(item) : null };
  }

  // "mission" / "skip" — no article behind the post.
  return NO_PRIMARY;
}

/**
 * The item the reservation WOULD claim, for callers that do not reserve — today
 * only the prompt preview.
 *
 * Mirrors claimFeedItem's rule (first claimable candidate in order) so a preview
 * shows the article a real generation would most likely pick. It is a forecast,
 * not a decision: nothing is claimed and no post is written from it.
 */
export function previewPrimaryItem(feedItems: readonly FeedItemContext[]): FeedItemContext | null {
  return feedItems.find(isConsumableItem) ?? feedItems.find((f) => !isConsumableItem(f)) ?? null;
}
