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
export const CONSUMABLE_SOURCE_TYPES = ["rss", "product_page", "listing_feed"] as const;
export type ConsumableSourceType = (typeof CONSUMABLE_SOURCE_TYPES)[number];

/** Whether a ContentSource.type produces single-use article feed items. */
export function isConsumableSourceType(type: string): boolean {
  return (CONSUMABLE_SOURCE_TYPES as readonly string[]).includes(type);
}

/**
 * Whether a source's ingestion writes ONE ROW PER THING, each of which is an
 * individually addressable item that backs exactly one post.
 *
 * This is NOT the same question as `isConsumableSourceType`, and the difference
 * is the whole reason both exist. `product_page` is consumable — its single row
 * is a one-shot article — but ingestion writes exactly ONE row for the entire
 * source, so a manual pick of it is read DIRECTLY from that row and reserves
 * nothing (see planDirectContentSource); reserving it would make the source
 * pickable once and permanently dry afterwards.
 *
 * `rss` and `listing_feed` are the per-item types: a feed has many articles and a
 * listing feed has many listings, each with its own URL, its own image, and its
 * own post. Those go down the RESERVING path, which is what sets
 * `Post.primaryFeedItemId` — and therefore what makes the appended source link
 * point at the individual listing rather than at the catalogue it came from.
 *
 * Used by the manual-pick router and the generation-source availability check, so
 * the two can never disagree about which window a source is offered from.
 */
const PER_ITEM_SOURCE_TYPES: readonly string[] = ["rss", "listing_feed"];

export function isPerItemSourceType(type: string | null | undefined): boolean {
  return type !== null && type !== undefined && PER_ITEM_SOURCE_TYPES.includes(type);
}

/**
 * Whether an item of this source type can carry its own stored image in
 * `FeedItem.sourceImageUrl`.
 *
 * Deliberately separate from "can we scrape a page to find one": an RSS article
 * has a readable page, so a missing image is resolved lazily by fetching it. A
 * listing's image arrives as a field of the provider's API response and is stored
 * at ingestion; its page is a JavaScript shell with no usable markup, so there is
 * nothing to scrape and a missing image simply means the listing has none.
 *
 * Callers that only READ a stored image use this; the one caller that may also
 * scrape keeps its own narrower `rss` check alongside it.
 */
export function providesSourceImage(type: string | null | undefined): boolean {
  return type === "rss" || type === "listing_feed";
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

/**
 * Whether a feed item's url is a real web address a reader could open.
 *
 * Ingestion stores a synthetic url for every source that has no page of its own
 * — `prompt:<sourceId>`, `event:<sourceId>` — purely as the per-source
 * uniqueness key. Those must never be appended to a post, so only an http(s)
 * url counts as linkable. rss and product_page items always carry a real one.
 */
export function hasPublicUrl(url: string | null | undefined): boolean {
  return /^https?:\/\//i.test((url ?? "").trim());
}

/**
 * The single answer to "what URL may this item show a reader?" — used for the
 * appended source link and for the post's frozen origin snapshot, so the two can
 * never disagree.
 *
 *   • `publicUrl` set    — the resolved address (a calendar event's Event URL,
 *                          or an rss/product_page item's own url)
 *   • `publicUrl` null   — the source has none; nothing may be linked
 *   • `publicUrl` absent — a context built before the field existed: fall back
 *                          to `url`, which keeps every pre-existing article path
 *                          behaving exactly as it did
 *
 * A synthetic `prompt:`/`event:` url never survives any of the three branches.
 */
export function publicUrlOf(item: Pick<FeedItemContext, "url" | "publicUrl">): string | null {
  const resolved = (item.publicUrl === undefined ? item.url : item.publicUrl) ?? "";
  return hasPublicUrl(resolved) ? resolved.trim() : null;
}

/**
 * Derives an item's public address from the stored row plus its source config —
 * the rule every reader of a raw FeedItem applies (the generation context, the
 * sources panel, the toggle response), so they cannot disagree about whether an
 * item is linkable.
 *
 * The item's own url wins whenever it is a real one, so an RSS feed's config url
 * can never be mistaken for one of its articles. Only a source whose items carry
 * a synthetic key falls through to the config, which is where a calendar event's
 * optional Event URL lives.
 */
export function resolveItemPublicUrl(itemUrl: string, sourceConfig: unknown): string | null {
  if (hasPublicUrl(itemUrl)) return itemUrl.trim();
  if (sourceConfig === null || typeof sourceConfig !== "object") return null;
  const configUrl = (sourceConfig as Record<string, unknown>).url;
  return typeof configUrl === "string" && hasPublicUrl(configUrl) ? configUrl.trim() : null;
}
