/**
 * The stretch of time the Channels → Analytics page reports on.
 *
 * Built the way `lib/calendar/calendar-range.ts` is built, and for the same
 * reason: a period is made of DAYS, not of instants. "The last 30 days" is 30
 * named days regardless of the fact that one of them is 23 hours long in
 * Europe/Sofia, and doing the arithmetic on `Date` objects in the business zone
 * is exactly how a DST weekend produces a chart with a day missing or doubled.
 * So the range is computed on `YYYY-MM-DD` strings with UTC arithmetic
 * underneath, where a day is always 24 hours and the answer is a pure function
 * of its input.
 *
 * The zone re-enters in one place only, at the edge: `analyticsWindowInstants`,
 * which turns the visible days back into the `[from, to)` instants the queries
 * need — through `appZoneInstant`, so the window covers the days the company
 * reads on its own clock rather than UTC's.
 *
 * The period lives in the URL (`?period=30d`), so it survives a reload, a shared
 * link, and — through `ChannelsShell`'s `query` prop — a channel switch. A
 * person comparing Facebook with Instagram over the last quarter means to change
 * the network, not to be thrown back to 30 days.
 */

import { addDays, addMonths } from "@/lib/calendar/calendar-range";
import { appZoneInstant } from "@/lib/scheduling/app-datetime-local";

/** The four periods the filter offers, in the order it shows them. */
export const ANALYTICS_PERIODS = ["7d", "30d", "3m", "1y"] as const;

export type AnalyticsPeriod = (typeof ANALYTICS_PERIODS)[number];

/**
 * What an absent or unrecognised `?period=` falls back to.
 *
 * 30 days rather than 7: Buffer refreshes metrics once a day and the analytics
 * cron reads a company's backlog over several runs, so a 7-day window can be
 * mostly unsynced on a company that publishes a few times a week. 30 days is the
 * shortest window that reliably contains something to look at.
 */
export const DEFAULT_ANALYTICS_PERIOD: AnalyticsPeriod = "30d";

/** The query-string key the period filter reads and writes. */
export const ANALYTICS_PERIOD_PARAM = "period";

/**
 * The period a URL names, or the default for anything else.
 *
 * Anything unrecognised — a typo, a repeated parameter, a period some future
 * build offered and this one does not — resolves to the default rather than
 * 404ing, matching `resolveCalendarView` and `resolveChannelScope`. Links
 * outlive the code that generated them.
 */
export function resolveAnalyticsPeriod(raw: string | string[] | undefined): AnalyticsPeriod {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return DEFAULT_ANALYTICS_PERIOD;

  const normalized = value.trim().toLowerCase();
  return (ANALYTICS_PERIODS as readonly string[]).includes(normalized)
    ? (normalized as AnalyticsPeriod)
    : DEFAULT_ANALYTICS_PERIOD;
}

export interface AnalyticsRange {
  period: AnalyticsPeriod;
  /** First day covered, inclusive. */
  startDay: string;
  /** Last day covered, inclusive — always "today" on the business clock. */
  endDay: string;
  /** Every day in the range, ascending. The chart's x-axis. */
  days: string[];
}

/**
 * The first day of a period whose last day is `endDay`.
 *
 * Both ends are INCLUSIVE, which is why the day counts are off by one from the
 * label: "7 days" ending today is today plus the six before it. The month-based
 * periods step by calendar months rather than by 90/365 days, so "3 months" ends
 * on the same day-of-month it started on however the months fell.
 */
function firstDayOf(period: AnalyticsPeriod, endDay: string): string {
  switch (period) {
    case "7d":
      return addDays(endDay, -6);
    case "30d":
      return addDays(endDay, -29);
    case "3m":
      return addDays(addMonths(endDay, -3), 1);
    case "1y":
      return addDays(addMonths(endDay, -12), 1);
  }
}

/**
 * The range for one period, anchored on the caller's business-zone today
 * (`appZoneToday`).
 *
 * Anchored on today rather than on a URL date because the analytics page has no
 * navigation backwards — there is no "previous 30 days" arrow, so no anchor to
 * carry. If one is ever added, this is the function that grows a parameter.
 */
export function buildAnalyticsRange(period: AnalyticsPeriod, today: string): AnalyticsRange {
  const startDay = firstDayOf(period, today);

  const days: string[] = [];
  for (let day = startDay; day <= today; day = addDays(day, 1)) days.push(day);

  return { period, startDay, endDay: today, days };
}

/**
 * The half-open instant window the range covers, on the business clock.
 *
 * `[startDay 00:00, day after endDay 00:00)` — half-open so a post published at
 * exactly midnight belongs to one day only, and derived through `appZoneInstant`
 * so the window is the company's days rather than UTC's. The two differ by two
 * or three hours, which is precisely the span in which an evening post would
 * otherwise be counted in the wrong period.
 */
export function analyticsWindowInstants(range: AnalyticsRange): { from: Date; to: Date } {
  const from = appZoneInstant(range.startDay, 0, 0);
  const to = appZoneInstant(addDays(range.endDay, 1), 0, 0);

  // Both days come from arithmetic on a validated day string, so neither can be
  // unreal — but `appZoneInstant` is nullable and swallowing that would turn a
  // future bug into a silently empty dashboard.
  if (from === null || to === null) {
    throw new Error(`Analytics range covers an unreal day: ${range.startDay} … ${range.endDay}`);
  }

  return { from, to };
}

/** The canonical query string for a period — what the channel switcher carries. */
export function analyticsPeriodQuery(period: AnalyticsPeriod): string {
  return new URLSearchParams({ [ANALYTICS_PERIOD_PARAM]: period }).toString();
}

/**
 * The query string for a period, preserving everything else already in the
 * URL — every other parameter on the page belongs to someone else.
 */
export function buildAnalyticsPeriodQuery(
  current: URLSearchParams | string,
  period: AnalyticsPeriod
): string {
  const params = new URLSearchParams(current);
  params.set(ANALYTICS_PERIOD_PARAM, period);
  return params.toString();
}
