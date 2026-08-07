/**
 * Manual content-source selection (the "Content source" dropdown).
 *
 * Applies to MANUAL generation only. The scheduled generator decides its source
 * from the content mix and never reads anything here — see
 * generate-weekly-schedule.service.ts, which builds its own SourceScope.
 *
 * Selection happens in two steps, because the wire cannot be trusted to say what
 * KIND of source an id names:
 *
 *   1. `parseManualContentSource` turns the raw dropdown value into a
 *      ManualContentSourceRef — a sentinel, or "some source id".
 *   2. `resolveManualContentSource` pairs that id with the source's real type,
 *      read from the DB, producing the ManualContentSourceSelection the whole
 *      pipeline runs on.
 *
 * The second step matters: RSS generation reserves a single unused FeedItem
 * (one-post-per-article), while a non-RSS source is read directly from its
 * stored extraction and consumes nothing. If the client could pick which of
 * those happened, a forged value could make an RSS article back two posts.
 *
 * The four resolved choices map onto the SourceScope the context builder
 * understands, so nothing downstream needs a fifth source-resolution path:
 *
 *   • company_rules   → pooled          — every enabled source, newest first.
 *                                         The pre-existing manual behaviour.
 *   • company_mission → company_content — no sources at all; write from the
 *                                         company profile / brand.
 *   • rss_source      → source          — that one RSS feed; a single unused
 *                                         article is reserved and consumed.
 *   • content_source  → content_source  — a product page / prompt / calendar
 *                                         source, read from its latest stored
 *                                         extraction; nothing is consumed and
 *                                         Post.primaryFeedItemId stays null.
 */

import type { SourceScope } from "@/lib/services/ai/build-generation-context.service";
import type { FeedItemContext } from "./types";
import { isConsumableItem } from "./source-types";

/**
 * Sentinel dropdown values. Namespaced with a `__` prefix so they can never
 * collide with a ContentSource id (a uuid), which is what every other value is.
 */
export const COMPANY_RULES_VALUE = "__company_rules__";
export const COMPANY_MISSION_VALUE = "__company_mission__";

/**
 * What the raw dropdown value says, before the picked source's type is known.
 * A `source` ref is only half an answer — see resolveManualContentSource.
 */
export type ManualContentSourceRef =
  { kind: "company_rules" } | { kind: "company_mission" } | { kind: "source"; sourceId: string };

/**
 * A fully resolved pick. The two source kinds are separate members rather than
 * one `sourceId` plus a type field, so a caller cannot read the id without
 * having decided which generation path it belongs to.
 */
export type ManualContentSourceSelection =
  | { kind: "company_rules" }
  | { kind: "company_mission" }
  /** An RSS feed: generation reserves one unused FeedItem and marks it used. */
  | { kind: "rss_source"; sourceId: string }
  /**
   * Any non-RSS source (product page, prompt, calendar event): generation reads
   * the content ingestion already stored for it. Reusable — no reservation.
   */
  | { kind: "content_source"; sourceId: string; sourceType: string };

/**
 * Resolves a raw dropdown value to a ref. An absent/empty value is the default
 * choice (company rules), which keeps a client that never sends the field — and
 * every pre-existing caller — on exactly the old behaviour.
 */
export function parseManualContentSource(raw: string | null | undefined): ManualContentSourceRef {
  if (!raw || raw === COMPANY_RULES_VALUE) return { kind: "company_rules" };
  if (raw === COMPANY_MISSION_VALUE) return { kind: "company_mission" };
  return { kind: "source", sourceId: raw };
}

/**
 * Pairs a ref with the picked source's ContentSource.type to produce the
 * selection generation runs on. The sentinels pass through untouched.
 *
 * `sourceType` is null when the source could not be resolved at all — deleted,
 * disabled, or belonging to another company — and the pick then yields null.
 * That is deliberately not a fallback to pooled generation: an explicit choice
 * that cannot be honoured is reported, never silently substituted.
 */
export function resolveManualContentSource(
  ref: ManualContentSourceRef,
  sourceType: string | null
): ManualContentSourceSelection | null {
  if (ref.kind !== "source") return ref;
  if (sourceType === null) return null;
  return sourceType === "rss"
    ? { kind: "rss_source", sourceId: ref.sourceId }
    : { kind: "content_source", sourceId: ref.sourceId, sourceType };
}

/** Whether the user picked a specific source rather than one of the sentinels. */
export function isPickedSource(
  selection: ManualContentSourceSelection
): selection is
  | { kind: "rss_source"; sourceId: string }
  | { kind: "content_source"; sourceId: string; sourceType: string } {
  return selection.kind === "rss_source" || selection.kind === "content_source";
}

/** Maps a selection onto the scope the context builder consumes. */
export function toSourceScope(selection: ManualContentSourceSelection): SourceScope {
  switch (selection.kind) {
    case "company_rules":
      return { kind: "pooled" };
    case "company_mission":
      return { kind: "company_content" };
    case "rss_source":
      return { kind: "source", sourceId: selection.sourceId };
    case "content_source":
      return { kind: "content_source", sourceId: selection.sourceId };
  }
}

/**
 * Whether a picked source can still back a post, given the context built for it.
 *
 * Only meaningful for a specific-source selection; the sentinels are always
 * usable (company rules pools whatever exists, company mission needs no source
 * at all).
 *
 * A source-scoped context window is already restricted to the chosen source, so
 * what is left in it is the whole answer — and the two source kinds ask it
 * differently:
 *
 *   • rss_source     — needs a consumable (unused article) item. An RSS pick
 *                      must produce an article post; evergreen leftovers are not
 *                      the article the user asked to write about.
 *   • content_source — needs any stored item at all. The window for this scope
 *                      is not filtered by `usedInPost`, so an empty one means
 *                      the source has never been extracted (or its extraction
 *                      was disabled), not that it is spent.
 *
 * Empty also covers a source disabled, deleted, or never belonging to this
 * company. All of those are the same answer to the user, and all must refuse
 * rather than fall back: a manual pick is an explicit instruction, so quietly
 * writing from some other source (or from the mission) would publish content
 * the user did not ask for.
 */
export function isSelectedSourceUsable(
  selection: ManualContentSourceSelection,
  feedItems: readonly Pick<FeedItemContext, "consumable">[]
): boolean {
  switch (selection.kind) {
    case "company_rules":
    case "company_mission":
      return true;
    case "rss_source":
      return feedItems.some(isConsumableItem);
    case "content_source":
      return feedItems.length > 0;
  }
}
