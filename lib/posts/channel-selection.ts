/**
 * Picking the channels a generation is written for.
 *
 * Generation used to address ONE channel, so the form held a single string and
 * the only invariant was "it is one of the connected ones". A topic written for
 * three channels turns that into a set, and a set has rules a string never
 * needed: it must never be empty, it must never name a channel this company
 * cannot publish to, and "All channels" has to keep meaning "all of the ones on
 * offer" as profiles are connected and disconnected.
 *
 * All of it is pure and lives here rather than in the form, because these are
 * the decisions worth testing — the checkboxes around them are not.
 *
 * Every function takes `available` as the authority on what exists. A selection
 * is only ever a subset of it, in ITS order, so the list the user reads never
 * reshuffles and a channel that was switched off in settings cannot survive in
 * form state that was saved before.
 */

/**
 * Display order for the four channels, and the labels beside them.
 *
 * One source of truth for both, because the same order has to hold in three
 * places that would otherwise drift: the generation form's checklist, the
 * version dropdown on a grouped post card, and the sibling ordering inside a
 * content group. Brand names, so they are deliberately not translated.
 */
export const CHANNEL_ORDER = ["FACEBOOK", "LINKEDIN", "INSTAGRAM", "TIKTOK"] as const;

export type KnownChannel = (typeof CHANNEL_ORDER)[number];

const CHANNEL_LABELS: Record<string, string> = {
  FACEBOOK: "Facebook",
  LINKEDIN: "LinkedIn",
  INSTAGRAM: "Instagram",
  TIKTOK: "TikTok",
};

/**
 * The channel's brand name, or the raw value when it is one this build does not
 * know about — a channel added server-side before the client caught up should
 * render as itself, not as a blank.
 */
export function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel.toUpperCase()] ?? channel;
}

/** Sort key for a channel; unknown channels sort after the four known ones. */
export function channelSortIndex(channel: string): number {
  const index = (CHANNEL_ORDER as readonly string[]).indexOf(channel.toUpperCase());
  return index === -1 ? CHANNEL_ORDER.length : index;
}

/** Orders channel-bearing items into the canonical display order, stably. */
export function sortByChannel<T>(items: readonly T[], channelOf: (item: T) => string): T[] {
  return [...items].sort((a, b) => channelSortIndex(channelOf(a)) - channelSortIndex(channelOf(b)));
}

/**
 * A selection reduced to what is actually on offer, in `available`'s order.
 *
 * This is the function that makes restored form state safe. A draft saved a week
 * ago, or a `channel` field written before the form was multi-select, can name a
 * profile that has since been disconnected — and a request for it would be
 * refused by the server after the user had already waited. Dropping it here
 * turns that into a checkbox that is simply not ticked.
 *
 * An empty result falls back to the first available channel rather than to
 * nothing: the form's invariant is that something is always selected, and a
 * silently empty checklist would put the user in front of a disabled button
 * with no indication of which box to tick. Genuinely empty only when the company
 * has connected nothing at all, which the form reports separately.
 */
export function normalizeChannelSelection(
  selected: readonly string[],
  available: readonly string[]
): string[] {
  const wanted = new Set(selected.map((c) => c.toUpperCase()));
  const kept = available.filter((c) => wanted.has(c.toUpperCase()));
  if (kept.length > 0) return kept;
  return available.length > 0 ? [available[0]] : [];
}

/**
 * The selection after a channel's checkbox is clicked.
 *
 * Unticking the last remaining channel is refused rather than allowed-and-then-
 * blocked. "At least one" is a property of the selection, so it is enforced
 * where the selection is made: the alternative — letting it empty and disabling
 * the generate button — asks the user to work out which of four boxes to tick to
 * make an error message go away. The form disables that last checkbox so the
 * refusal is visible rather than a click that appears to do nothing.
 *
 * A channel that is not available is ignored outright; it cannot be added by any
 * route this function offers.
 */
export function toggleChannelSelection(
  selected: readonly string[],
  channel: string,
  available: readonly string[]
): string[] {
  const target = channel.toUpperCase();
  if (!available.some((c) => c.toUpperCase() === target)) {
    return normalizeChannelSelection(selected, available);
  }

  const current = new Set(
    normalizeChannelSelection(selected, available).map((c) => c.toUpperCase())
  );

  if (current.has(target)) {
    // The last one standing: keep it. See above.
    if (current.size === 1) return [...current];
    current.delete(target);
  } else {
    current.add(target);
  }

  return available.filter((c) => current.has(c.toUpperCase()));
}

/**
 * Whether "All channels" should read as ticked.
 *
 * Derived from the selection rather than stored beside it. A stored flag would
 * be a second source of truth that has to be re-synchronised every time a
 * channel is ticked, a draft is restored, or a profile is connected — three
 * chances for the box to disagree with the boxes under it.
 */
export function isAllChannelsSelected(
  selected: readonly string[],
  available: readonly string[]
): boolean {
  if (available.length === 0) return false;
  const chosen = new Set(
    normalizeChannelSelection(selected, available).map((c) => c.toUpperCase())
  );
  return available.every((c) => chosen.has(c.toUpperCase()));
}

/**
 * The selection after "All channels" is clicked.
 *
 * Ticking it selects everything currently on offer — "all" is resolved against
 * what exists now, never against a remembered list. Unticking it falls back to a
 * single channel rather than to none, for the same reason the individual toggle
 * refuses to empty the set. The first available channel is the one kept, which
 * is also the form's own default.
 */
export function toggleAllChannels(
  selected: readonly string[],
  available: readonly string[]
): string[] {
  if (available.length === 0) return [];
  if (isAllChannelsSelected(selected, available)) return [available[0]];
  return [...available];
}

/**
 * The selection as the API wants it: lowercase, which is how `SocialChannel` is
 * spelled on the wire and in the database. The form works in uppercase because
 * that is what `PostItem.channel` and the badges use.
 */
export function toChannelPayload(selected: readonly string[]): string[] {
  return selected.map((c) => c.toLowerCase());
}
