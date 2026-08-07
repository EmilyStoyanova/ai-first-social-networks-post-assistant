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
