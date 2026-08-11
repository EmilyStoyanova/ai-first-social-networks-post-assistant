/**
 * Spreading a manual bulk generation across a date range.
 *
 * "5 posts between 2026-08-17 and 2026-08-30" has to become five concrete
 * `Post.scheduledFor` instants before anything is generated, because each post
 * is persisted with its slot as it is written — a run that stops early must
 * still leave the posts it did write on sensible dates.
 *
 * The two dates are a PERMITTED PERIOD, not a pair of publishing dates. Nothing
 * is placed on `startDate` or `endDate` merely because they are the ends of the
 * range; a post lands there only when that is genuinely where an even spread
 * puts it. What decides the actual dates is the channel's configured posting
 * windows:
 *
 *   1. every configured window that falls inside the period becomes an ELIGIBLE
 *      SLOT (its day, at its start time),
 *   2. the requested posts are distributed evenly across that eligible list.
 *
 * So a channel configured for Tuesdays and Thursdays at 08:30 gets posts on
 * Tuesdays and Thursdays at 08:30 — never on the Sunday the range happens to
 * start on. See `deriveEligibleSlots` for the two fallbacks (no windows at all,
 * and windows whose days never occur in the period) and `planBulkSlots` for the
 * one used when there are fewer eligible slots than requested posts.
 *
 * `planCustomSlots` is the same idea with the user holding the calendar: they
 * say which days carry how many posts, and the channel's windows still decide
 * the time of day. Both planners run unchanged in the browser (to preview the
 * dates before generating) and on the server (to schedule them), which is why
 * this module stays pure — a second implementation in the form is exactly how a
 * preview starts lying.
 *
 * TIME ZONE. The dates are plain calendar days and are handled as such (UTC
 * midnight is only ever a marker for "this day"), but the TIME OF DAY a slot
 * lands at is business-zone wall clock: a channel configured for 18:30 is
 * scheduled at 18:30 in Sofia, which is what the form shows and what the post
 * card reads back. See `slotInstant`, and lib/scheduling/posting-windows.ts for
 * why the weekly cron still applies the same windows as UTC.
 *
 * Pure: no Prisma, no clock, no LLM.
 */

import {
  DAY_ORDER,
  postingWindowsSchema,
  resolveWindowStart,
  utcDayIndex,
  DEFAULT_POSTING_HOUR,
} from "./posting-windows";
import type { TimeOfDay } from "./posting-windows";
import { appZoneClock, appZoneInstant, appZoneToday } from "./app-datetime-local";

/**
 * Upper bound on one bulk request. Each post is a full generation — an LLM call
 * (plus its retries) and usually an image — so this is a bound on how long one
 * HTTP request may run, not a product opinion about how many posts a company
 * should have.
 */
export const MAX_BULK_POSTS = 10;

/**
 * Longest period a bulk request may span, in days.
 *
 * Slot derivation walks the period a day at a time, so an unbounded range is an
 * unbounded allocation inside a request handler — `9999-12-31` is ~2.9 million
 * days. A year is far beyond any real use of "generate up to 10 posts", so the
 * bound costs nothing and removes the question entirely.
 */
export const MAX_BULK_RANGE_DAYS = 366;

/** Latest hour a same-day overflow post may be pushed to. */
const LAST_HOUR_OF_DAY = 23;

export interface BulkSlotPlan {
  /** Inclusive, `YYYY-MM-DD`, read as UTC. */
  startDate: string;
  /** Inclusive, `YYYY-MM-DD`, read as UTC. */
  endDate: string;
  count: number;
  /** `ChannelConfig.postingWindows` as stored; anything unparseable means 10:00. */
  postingWindows?: unknown;
}

/** One day of a user-authored distribution: "three posts on 2026-08-19". */
export interface BulkCustomDay {
  /** `YYYY-MM-DD`, read as UTC. */
  date: string;
  /** Posts to write on that day; at least 1. */
  count: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Parses a `YYYY-MM-DD` day into its UTC midnight, or null if it is not one. */
export function parseIsoDate(value: string): Date | null {
  if (!ISO_DATE.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  // Rejects real-looking but non-existent days (2026-02-30 rolls over to March).
  return date.toISOString().slice(0, 10) === value ? date : null;
}

/**
 * Whole UTC days covered by an inclusive bulk range.
 *
 * Null when the range is unusable: either date unparseable, end before start, or
 * a period longer than `MAX_BULK_RANGE_DAYS`. Callers turn that into a proper
 * error code; the planner treats it as "plan nothing".
 */
export function inclusiveDayCount(startDate: string, endDate: string): number | null {
  const start = parseIsoDate(startDate);
  const end = parseIsoDate(endDate);
  if (!start || !end) return null;
  if (end.getTime() < start.getTime()) return null;
  const days = Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;
  return days > MAX_BULK_RANGE_DAYS ? null : days;
}

/**
 * Whether a bulk period starts on a day that has already gone by.
 *
 * A bulk request writes real publish times, so a period starting last week
 * produces posts that are past due the moment they are approved — the publisher
 * refuses to fire them (lib/scheduling/publish-window.ts) and the user is left
 * with a batch of drafts nobody asked to be stranded. Cheaper to refuse the
 * request.
 *
 * Day granularity, in the BUSINESS zone, because that is the granularity the
 * form offers and the zone its dates are read in. Today itself is allowed: a
 * same-day batch is a legitimate thing to want, and the channel's later windows
 * are still ahead. (A window earlier today is not filtered out — see the
 * publisher's grace window for what happens to one.)
 *
 * Shared by the form and the service so the button and the API agree, exactly as
 * `validateCustomDistribution` is.
 */
export function isStartDateInPast(startDate: string, now: Date): boolean {
  const start = parseIsoDate(startDate);
  if (start === null) return false; // not this rule's business; the range check rejects it
  return startDate < appZoneToday(now);
}

/**
 * The channel's posting times grouped by weekday, indexed by DAY_ORDER position
 * (0 = Monday). Null when nothing usable is configured.
 *
 * A day may carry several windows (morning and evening, say); each becomes its
 * own eligible slot. Exact repeats are dropped so a duplicated window entry
 * cannot make one time of day look twice as available as it is.
 */
function windowsByWeekday(postingWindows: unknown): TimeOfDay[][] | null {
  const parsed = postingWindowsSchema.safeParse(postingWindows);
  if (!parsed.success || parsed.data.length === 0) return null;

  const byDay: TimeOfDay[][] = DAY_ORDER.map(() => []);
  for (const window of parsed.data) {
    const [hour, minute] = window.start.split(":").map(Number);
    const times = byDay[DAY_ORDER.indexOf(window.day)];
    if (!times.some((t) => t.hour === hour && t.minute === minute)) times.push({ hour, minute });
  }
  for (const times of byDay) times.sort((a, b) => a.hour - b.hour || a.minute - b.minute);
  return byDay;
}

/**
 * The instant a slot on `day` at `time` names — the one place this module turns
 * a calendar day plus a configured time into a `Post.scheduledFor`.
 *
 * `day` is a UTC-midnight marker for a calendar day; `time` is business-zone
 * wall clock, because that is what a person configuring "18:30" means and what
 * every screen in the app renders. Assembling it with `setUTCHours` instead
 * would publish three hours late all summer.
 */
function slotInstant(day: Date, time: TimeOfDay): Date {
  const iso = day.toISOString().slice(0, 10);
  const at = appZoneInstant(iso, time.hour, time.minute);
  if (at !== null) return at;

  // The stored windows are shape-checked, not range-checked, so a `"25:00"` is
  // possible. Treat it as unconfigured — a slot at the channel's default hour —
  // rather than silently moving the post onto the following day.
  return appZoneInstant(iso, DEFAULT_POSTING_HOUR, 0) ?? new Date(day);
}

/** Every day in the period at the time `resolveWindowStart` gives that weekday. */
function everyDayInPeriod(start: Date, days: number, postingWindows: unknown): Date[] {
  const slots: Date[] = [];
  for (let offset = 0; offset < days; offset++) {
    const day = new Date(start.getTime() + offset * DAY_MS);
    slots.push(slotInstant(day, resolveWindowStart(postingWindows, utcDayIndex(day))));
  }
  return slots;
}

/**
 * Every instant inside the period at which this channel is configured to
 * publish, earliest first.
 *
 * This is the candidate set the requested posts are drawn from — it is what
 * "prefer the channel's configured posting days and times" actually means. One
 * slot per configured window per matching day.
 *
 * Two fallbacks, both giving every day in the period rather than refusing to
 * plan (a bulk request must not fail because of how a channel was configured):
 *
 *   • No windows configured, or unparseable JSON — every day at 10:00, the same
 *     default the weekly scheduler uses.
 *   • Windows configured, but none of their weekdays occur in this period (a
 *     Monday-only channel asked for a Tue–Thu range) — every day at the first
 *     configured window's time, so the channel at least keeps its usual hour.
 *     Honouring the days here would mean generating nothing at all, which is a
 *     worse answer to "give me 5 posts next week" than posting off-schedule.
 *
 * Empty only when the range itself is unusable.
 */
export function deriveEligibleSlots(plan: BulkSlotPlan): Date[] {
  const days = inclusiveDayCount(plan.startDate, plan.endDate);
  const start = parseIsoDate(plan.startDate);
  if (days === null || start === null) return [];

  const byDay = windowsByWeekday(plan.postingWindows);
  if (byDay === null) return everyDayInPeriod(start, days, plan.postingWindows);

  // Days ascending, and each day's times already sorted — so this comes out
  // chronological without a second sort.
  const configured: Date[] = [];
  for (let offset = 0; offset < days; offset++) {
    const day = new Date(start.getTime() + offset * DAY_MS);
    for (const time of byDay[utcDayIndex(day)]) configured.push(slotInstant(day, time));
  }

  return configured.length > 0 ? configured : everyDayInPeriod(start, days, plan.postingWindows);
}

/**
 * The scheduled instants for one bulk run, earliest first.
 *
 * The posts are spread evenly over the eligible slots by stratified sampling:
 * the eligible list is cut into `count` equal shares and each post takes the
 * slot at the centre of its share. Centres, not edges — that is precisely what
 * keeps the first and last posts off the boundaries of the period unless the
 * spread genuinely lands them there. (Three posts over a fortnight of daily
 * slots come out at roughly days 2, 7 and 12, not 1, 7 and 14.)
 *
 * FALLBACK — more posts requested than there are eligible slots. Every post
 * still maps to a share centre, so several posts share a slot; each one that
 * would land at or before the previous post is pushed to one hour after it.
 * Deterministic, chronological, and it keeps the posts inside the channel's
 * configured rhythm instead of inventing new posting days. Past 23:00 they stop
 * moving and may share a time — reaching that needs a channel whose window is
 * already late in the evening plus a period short enough to pile the whole
 * batch onto it, and nothing is silently lost when it happens.
 *
 * Returns an empty array for a non-positive count or an unusable range; callers
 * validate first and report a proper error code, so this only has to be safe.
 */
export function planBulkSlots(plan: BulkSlotPlan): Date[] {
  if (plan.count < 1) return [];

  const eligible = deriveEligibleSlots(plan);
  if (eligible.length === 0) return [];

  const slots: Date[] = [];
  let previous: Date | null = null;

  for (let i = 0; i < plan.count; i++) {
    const index = Math.min(
      eligible.length - 1,
      Math.floor(((i + 0.5) * eligible.length) / plan.count)
    );

    const when = pushPastPrevious(eligible[index], previous);
    slots.push(when);
    previous = when;
  }

  return slots;
}

/**
 * `candidate`, moved to an hour after `previous` if it would not otherwise be
 * strictly later — the shared rule for "two posts want the same slot".
 *
 * Clamped at 23:00 rather than spilling into the next day: a post must never
 * silently move off the day it was planned for (in a custom distribution, the
 * day the user typed). Reaching the clamp needs a late window plus more posts
 * than the day has room for, and nothing is dropped when it happens.
 *
 * Both the hour and the day here are business-zone, matching the slots being
 * pushed — 23:00 means 23:00 in Sofia, and "the same day" is the Sofia day.
 */
function pushPastPrevious(candidate: Date, previous: Date | null): Date {
  if (previous === null || candidate.getTime() > previous.getTime()) {
    return new Date(candidate.getTime());
  }

  const clock = appZoneClock(previous);
  if (clock === null) return new Date(previous.getTime());

  const hour = Math.min(LAST_HOUR_OF_DAY, clock.hour + 1);
  return appZoneInstant(clock.day, hour, clock.minute) ?? new Date(previous.getTime());
}

// ─── Custom distribution ───────────────────────────────────────────────────────

/**
 * Why a user-authored distribution cannot be used.
 *
 * Returned rather than thrown so the same check can gate the submit button in
 * the browser and reject the request on the server — one rule, two callers, no
 * chance of the form permitting something the API refuses.
 */
export type CustomDistributionError =
  | "empty"
  | "invalid_date"
  | "duplicate_date"
  | "out_of_period"
  | "invalid_count"
  | "count_mismatch";

/**
 * Checks a custom distribution against the request it belongs to, returning the
 * first problem found or null when it is usable.
 *
 * `total` is the requested number of posts: the per-day counts must add up to
 * exactly that, because the number the user asked for and the number the days
 * describe are the same number shown twice.
 */
export function validateCustomDistribution(
  days: readonly BulkCustomDay[],
  total: number,
  startDate: string,
  endDate: string
): CustomDistributionError | null {
  if (days.length === 0) return "empty";

  const start = parseIsoDate(startDate);
  const end = parseIsoDate(endDate);
  if (start === null || end === null || inclusiveDayCount(startDate, endDate) === null) {
    return "out_of_period";
  }

  const seen = new Set<string>();
  let sum = 0;

  for (const day of days) {
    const date = parseIsoDate(day.date);
    if (date === null) return "invalid_date";
    if (seen.has(day.date)) return "duplicate_date";
    seen.add(day.date);
    // The dates bound the period in this mode too — a day outside it was never
    // offered by the form, so it can only be a stale or hand-made request.
    if (date.getTime() < start.getTime() || date.getTime() > end.getTime()) return "out_of_period";
    if (!Number.isInteger(day.count) || day.count < 1) return "invalid_count";
    sum += day.count;
  }

  return sum === total ? null : "count_mismatch";
}

/**
 * The scheduled instants for a user-authored distribution, earliest first.
 *
 * The user chose the DAYS and how many posts each carries; the channel still
 * chooses the TIMES. A day's posts fill that weekday's configured windows in
 * order, so a channel with a 09:00 and an 18:30 window asked for two posts that
 * day publishes at 09:00 and 18:30. Anything past the last configured window
 * stacks an hour apart from it, the same overflow rule even distribution uses.
 * A day with no window of its own (or a channel with none at all) falls back to
 * `resolveWindowStart`, i.e. the channel's usual hour, or 10:00.
 *
 * Invalid days are skipped rather than guessed at; callers run
 * `validateCustomDistribution` first and report a proper error code.
 */
export function planCustomSlots(days: readonly BulkCustomDay[], postingWindows?: unknown): Date[] {
  const byDay = windowsByWeekday(postingWindows);

  const ordered = days
    .flatMap((day) => {
      const date = parseIsoDate(day.date);
      return date !== null && Number.isInteger(day.count) && day.count > 0
        ? [{ date, count: day.count }]
        : [];
    })
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  const slots: Date[] = [];

  for (const { date, count } of ordered) {
    const configured = byDay?.[utcDayIndex(date)] ?? [];
    const times: TimeOfDay[] =
      configured.length > 0 ? configured : [resolveWindowStart(postingWindows, utcDayIndex(date))];

    // Restarts each day: a day's own windows are what its posts fill, and the
    // previous day's last slot must never push today's first one later.
    let previous: Date | null = null;

    for (let i = 0; i < count; i++) {
      const candidate = slotInstant(date, times[Math.min(i, times.length - 1)]);
      const when = pushPastPrevious(candidate, previous);
      slots.push(when);
      previous = when;
    }
  }

  return slots;
}
