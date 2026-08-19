/**
 * What may be added up, what may be compared, and which network a figure
 * belongs to.
 *
 * Every rule the Analytics dashboard applies to a number lives here, pure and
 * without Prisma, so the decisions are testable without a database and cannot be
 * restated differently by the four sections that use them (KPI cards, chart,
 * top posts, source performance).
 *
 * Three rules run through all of it:
 *
 *  1. **NULL is not 0.** Buffer omits a metric a network does not report, and
 *     `impressions: 0` on an Instagram post would be a claim Instagram never
 *     made. A metric no post reported stays null and renders as "—"; a metric
 *     some post reported as a genuine 0 counts as 0. That is also why averages
 *     divide by the number of posts that REPORTED the metric, never by the
 *     number of posts.
 *
 *  2. **Only comparable quantities are blended.** Reactions, comments and shares
 *     count the same user action on every network. Impressions and clicks are
 *     Facebook-only in observed data, reach/views/saves/follows Instagram-only,
 *     and `engagementRate` is computed against impressions on Facebook and reach
 *     on Instagram — so none of those may be summed or averaged across networks.
 *     `metricsForScope` is what enforces it: All Channels gets the three
 *     comparable actions and nothing else.
 *
 *  3. **Buffer says which network a post landed on.** `PostMetric.channelService`
 *     is authoritative, translated through the app's one service→channel map.
 *     `Post.channel` is what the post was WRITTEN for, and the two have been
 *     observed disagreeing (care-tech, 2026-08-14).
 */

import { bufferServiceToChannel } from "@/lib/buffer/profile-channel";
import { ALL_CHANNELS, type ChannelScope } from "@/lib/channels/channel-scope";

/**
 * The three metrics that mean the same thing on every network — the only ones
 * All Channels is allowed to add up.
 */
export const ENGAGEMENT_ACTIONS = ["reactions", "comments", "shares"] as const;

/**
 * Metrics whose availability and definition are the network's own. Shown only
 * inside a single channel, and only when that channel actually reported them —
 * which is how LinkedIn shows whatever it has without anything being hardcoded
 * for it.
 */
export const NETWORK_METRICS = [
  "impressions",
  "clicks",
  "reach",
  "views",
  "saves",
  "follows",
] as const;

export const COUNT_METRICS = [...ENGAGEMENT_ACTIONS, ...NETWORK_METRICS] as const;

export type CountMetric = (typeof COUNT_METRICS)[number];

/** The figures a post or a snapshot carries. Every one nullable — see rule 1. */
export type MetricFigures = { [K in CountMetric]: number | null };

/** As much of a post as the attribution rule needs. */
export interface AttributableRow {
  /** `Post.channel` — what the post was written for. The fallback, never the authority. */
  channel: string;
  /** `PostMetric.channelService` — Buffer's own word for where it landed. */
  channelService: string | null;
}

/**
 * The network a post's metrics belong to, uppercase.
 *
 * Buffer's `channelService` wins whenever it is present and placeable: it
 * records where the post actually went, which is the only thing an engagement
 * figure can be about. `bufferServiceToChannel` does the translation, because
 * Buffer spells the same network several ways (`instagram-business`,
 * `facebook-group`, `linkedin-company`) and a raw string comparison would file
 * every business Instagram account under nothing at all.
 *
 * `Post.channel` is used only when Buffer has not told us — a post the metrics
 * sync has not reached yet, which is a real and common state (a company's whole
 * first day, and any post behind the daily backlog). Dropping those posts would
 * make "Published posts" disagree with the Posts tab for no reason a user could
 * see; they simply have no engagement figures to misfile.
 */
export function analyticsChannelOf(row: AttributableRow): string {
  const fromBuffer = row.channelService ? bufferServiceToChannel(row.channelService) : null;
  return (fromBuffer ?? row.channel).toUpperCase();
}

/** Whether a post's metrics belong in the current scope. */
export function matchesAnalyticsScope(row: AttributableRow, scope: ChannelScope): boolean {
  if (scope === ALL_CHANNELS) return true;
  return analyticsChannelOf(row) === scope.toUpperCase();
}

/** Narrows loaded rows to the scope, by the rule above. */
export function filterByAnalyticsScope<T extends AttributableRow>(
  rows: readonly T[],
  scope: ChannelScope
): T[] {
  if (scope === ALL_CHANNELS) return [...rows];
  return rows.filter((row) => matchesAnalyticsScope(row, scope));
}

/**
 * The total of one metric, or null when no row reported it.
 *
 * Null and zero are different answers: null means "this network does not measure
 * it", zero means "measured, and nothing happened".
 */
export function sumMetric(
  rows: readonly Partial<MetricFigures>[],
  metric: CountMetric
): number | null {
  let total = 0;
  let reported = 0;

  for (const row of rows) {
    const value = row[metric];
    if (value == null) continue;
    total += value;
    reported++;
  }

  return reported === 0 ? null : total;
}

export interface MetricAverage {
  /** Null when no row reported the metric at all. */
  value: number | null;
  /** How many rows reported it — the denominator, and worth showing. */
  reported: number;
}

/**
 * The mean of one metric across the rows that REPORTED it.
 *
 * The denominator is the point of this function. If 4 of 10 posts report reach,
 * the average reach is the sum over 4, not over 10: treating the six silent
 * posts as zeroes would invent six observations Instagram never made and halve
 * a real figure.
 */
export function averageMetric(
  rows: readonly Partial<MetricFigures>[],
  metric: CountMetric
): MetricAverage {
  let total = 0;
  let reported = 0;

  for (const row of rows) {
    const value = row[metric];
    if (value == null) continue;
    total += value;
    reported++;
  }

  return reported === 0 ? { value: null, reported: 0 } : { value: total / reported, reported };
}

/**
 * The metrics a scope may display.
 *
 * All Channels gets the three comparable actions and stops there — see rule 2.
 * A single channel gets those three plus every network metric at least one of
 * its posts actually reported, which is what lets Facebook show impressions and
 * clicks, Instagram show reach and saves, and LinkedIn show exactly whatever is
 * in its stored data without a per-network list anywhere in the code.
 *
 * The three comparable actions are always offered even when nothing reported
 * them — they are the metrics a user comes to this page for, and "—" is a more
 * useful answer than a card that silently vanished.
 */
export function metricsForScope(
  rows: readonly Partial<MetricFigures>[],
  scope: ChannelScope
): CountMetric[] {
  if (scope === ALL_CHANNELS) return [...ENGAGEMENT_ACTIONS];

  const present = NETWORK_METRICS.filter((metric) => rows.some((row) => row[metric] != null));
  return [...ENGAGEMENT_ACTIONS, ...present];
}

export interface EngagementRateSummary {
  /** Mean of the per-post rates that exist, as a percentage. Null when none do. */
  value: number | null;
  /** How many posts reported a rate. */
  reported: number;
  /**
   * The denominator Buffer computed those rates against — "impressions" or
   * "reach". Null when the rows disagree, which makes the figure unlabelled and
   * therefore not worth showing.
   */
  basis: string | null;
}

/**
 * The average engagement rate across posts that reported one.
 *
 * Only ever called for a SINGLE channel. Buffer computes the rate against
 * impressions on Facebook and reach on Instagram, so averaging across networks
 * would average two different ratios; within one network the denominator is the
 * same for every post and the mean is a real per-post average.
 *
 * It is still an average of per-post ratios, not the company's engagement rate
 * over the period — the UI labels it as such, and `basis` carries the
 * denominator so the label can say which one.
 */
export function averageEngagementRate(
  rows: readonly { engagementRate: number | null; engagementRateDenominator: string | null }[]
): EngagementRateSummary {
  let total = 0;
  let reported = 0;
  const bases = new Set<string>();

  for (const row of rows) {
    if (row.engagementRate == null) continue;
    total += row.engagementRate;
    reported++;
    if (row.engagementRateDenominator) bases.add(row.engagementRateDenominator);
  }

  if (reported === 0) return { value: null, reported: 0, basis: null };

  return {
    value: total / reported,
    reported,
    // One agreed denominator or nothing. Two different ones inside a single
    // channel should be impossible; if it ever happens the honest response is to
    // drop the label, not to pick a winner.
    basis: bases.size === 1 ? [...bases][0] : null,
  };
}

/**
 * The engagement a post attracted, counted in user actions.
 *
 * THE channel-neutral quantity: a reaction, a comment and a share are the same
 * three things a person does on Facebook, Instagram and LinkedIn alike, so this
 * is the one score that means the same thing in every scope. Null when the post
 * reported none of the three — that post has not been measured, which is
 * different from having been measured at zero.
 */
export function engagementActions(row: Partial<MetricFigures>): number | null {
  let total = 0;
  let reported = 0;

  for (const metric of ENGAGEMENT_ACTIONS) {
    const value = row[metric];
    if (value == null) continue;
    total += value;
    reported++;
  }

  return reported === 0 ? null : total;
}
