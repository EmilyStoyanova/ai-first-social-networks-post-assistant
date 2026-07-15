import type { FeedItemContext } from "./types";

/**
 * Content-source classification (V2).
 *
 * "Consumable" (article) sources — rss, product_page — produce single-use feed
 * items that are subject to the one-post-per-article reservation (Phase 0): each
 * article backs at most one post and is marked `usedInPost` once claimed.
 *
 * "Evergreen" sources — prompt, calendar_event — are reusable context. Their
 * feed items are never claimed and never marked used, so the same prompt can
 * seed many posts across generations.
 */
export const CONSUMABLE_SOURCE_TYPES = ["rss", "product_page"] as const;
export type ConsumableSourceType = (typeof CONSUMABLE_SOURCE_TYPES)[number];

/** Whether a ContentSource.type produces single-use article feed items. */
export function isConsumableSourceType(type: string): boolean {
  return (CONSUMABLE_SOURCE_TYPES as readonly string[]).includes(type);
}

/**
 * Whether a feed item is a single-use article (claimed + consumed) rather than
 * evergreen. Items default to consumable so legacy/article contexts that omit
 * the flag keep the existing one-post-per-article behaviour; evergreen items
 * set `consumable: false` explicitly.
 */
export function isConsumableItem(item: Pick<FeedItemContext, "consumable">): boolean {
  return item.consumable !== false;
}
