/**
 * Which channels the Overview performance panel may show, and which one it is
 * showing.
 *
 * The panel reports one channel at a time by construction — Buffer's figures
 * are not comparable across networks, so there is no "all channels" option
 * (see ChannelPerformance in get-overview-data.service.ts). That makes "which
 * channel" a real choice, and this file owns the two rules behind it:
 *
 *  1. **Buffer-connected.** A channel with no Buffer profile has no source of
 *     metrics at all, so offering it would be offering an empty panel.
 *  2. **Has published at least once.** A connected but unused channel has
 *     nothing to report either.
 *
 * Both rules are about the *company*, not about the metrics table, and that is
 * deliberate: a connected channel that has published but whose metrics have not
 * been read yet stays in the list and shows "no metrics collected yet". The
 * alternative — deriving the list from PostMetric rows — makes options appear
 * and disappear with the daily sync, so a user who saw Facebook yesterday could
 * find it missing today with nothing on screen to explain why.
 *
 * Kept free of Prisma and React so both callers (the server service that
 * queries, the client control that renders) agree on one implementation, and so
 * the rules are testable without a database.
 */

/** The query-string key the performance panel reads and writes. */
export const PERFORMANCE_CHANNEL_PARAM = "channel";

/**
 * Display names for the four channels the app supports.
 *
 * Capitalisation is each network's own ("LinkedIn", "TikTok"); a title-cased
 * enum value would spell two of the four wrong.
 */
const CHANNEL_LABELS: Record<string, string> = {
  FACEBOOK: "Facebook",
  LINKEDIN: "LinkedIn",
  INSTAGRAM: "Instagram",
  TIKTOK: "TikTok",
};

/**
 * Channel identifiers arrive lowercase from Prisma enums and in Buffer's own
 * casing from the analytics API. Upper case is the app's internal form.
 */
export function normalizeChannel(value: string): string {
  return value.trim().toUpperCase();
}

/** A network's own name, falling back to the raw identifier for anything new. */
export function channelLabel(channel: string): string {
  const key = normalizeChannel(channel);
  return CHANNEL_LABELS[key] ?? channel;
}

export interface ChannelEligibilityInput {
  /** Channels wired to a Buffer profile. */
  bufferConnected: readonly string[];
  /** Channels with at least one post that reached Buffer. */
  withPublishedPosts: readonly string[];
}

/**
 * The channels the switcher may offer, alphabetical so the order does not move
 * under the user as posts are published.
 */
export function eligiblePerformanceChannels({
  bufferConnected,
  withPublishedPosts,
}: ChannelEligibilityInput): string[] {
  const published = new Set(withPublishedPosts.map(normalizeChannel));
  const eligible = new Set(
    bufferConnected.map(normalizeChannel).filter((channel) => published.has(channel))
  );
  return [...eligible].sort();
}

/**
 * The channel to show, given what the URL asked for.
 *
 * An unknown, stale or absent `?channel=` falls back to the first eligible one
 * rather than to an empty panel: links outlive channel connections, and a user
 * following an old bookmark should land on data, not on a blank card.
 */
export function resolvePerformanceChannel(
  eligible: readonly string[],
  requested: string | string[] | undefined
): string | null {
  const raw = Array.isArray(requested) ? requested[0] : requested;
  if (typeof raw === "string") {
    const normalized = normalizeChannel(raw);
    if (eligible.includes(normalized)) return normalized;
  }
  return eligible[0] ?? null;
}

/**
 * The query string for a channel, preserving everything else already in the
 * URL — every other parameter on the overview belongs to someone else.
 */
export function buildPerformanceChannelQuery(
  current: URLSearchParams | string,
  channel: string
): string {
  const params = new URLSearchParams(current);
  params.set(PERFORMANCE_CHANNEL_PARAM, normalizeChannel(channel));
  return params.toString();
}
