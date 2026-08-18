/**
 * The stretch of time the calendar is showing, and how the toolbar moves it.
 *
 * ── Why everything here is a `YYYY-MM-DD` string ─────────────────────────────
 *
 * A calendar grid is made of DAYS, not of instants. "The week of 2026-03-23"
 * contains seven named days regardless of the fact that one of them is 23 hours
 * long in Europe/Sofia — and doing the arithmetic on `Date` objects in the
 * business zone is exactly how a DST weekend turns into a grid with a day
 * missing or repeated. So navigation, week starts, month bounds and the grid
 * itself are all computed on day strings with UTC arithmetic underneath, where a
 * day is always 24 hours and the answer is a pure function of the input.
 *
 * The zone re-enters in exactly two places, both at the edges:
 *
 *   • `calendarWindowInstants` turns the visible days back into the [from, to)
 *     instants the database query needs — through `appZoneInstant`, so the
 *     window covers the days the company reads on its own clock rather than
 *     UTC's;
 *   • placing a post onto a day, which is `lib/calendar/calendar-entries.ts`.
 *
 * Weeks start on MONDAY, which is not a preference: `WeeklySchedule.weekStart`
 * and the cron's `nextWeekStart` already define a week that way, and a calendar
 * whose weeks began on Sunday would draw a boundary the scheduler does not have.
 */

import { appZoneInstant } from "@/lib/scheduling/app-datetime-local";

export const CALENDAR_VIEWS = ["week", "month"] as const;

export type CalendarView = (typeof CALENDAR_VIEWS)[number];

/** What an absent or unrecognized `?view=` falls back to. */
export const DEFAULT_CALENDAR_VIEW: CalendarView = "week";

/** The query-string keys the calendar reads and writes. */
export const CALENDAR_VIEW_PARAM = "view";
export const CALENDAR_DATE_PARAM = "date";

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A day string as a UTC midnight instant — the carrier for the arithmetic below. */
function toUtcMidnight(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function toDayString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Whether a string is a real calendar day.
 *
 * The round trip is what rejects `2026-02-30`: it parses (rolling over into
 * March) rather than failing, so pattern-matching alone would accept a date
 * nobody can navigate to. Same guard, and same reason, as `appZoneInstant`.
 */
export function isCalendarDay(value: string): boolean {
  if (!DAY_PATTERN.test(value)) return false;
  const parsed = toUtcMidnight(value);
  return !Number.isNaN(parsed.getTime()) && toDayString(parsed) === value;
}

/** `day` moved by `count` calendar days. */
export function addDays(day: string, count: number): string {
  const date = toUtcMidnight(day);
  date.setUTCDate(date.getUTCDate() + count);
  return toDayString(date);
}

/** `day` moved by `count` calendar months, clamped to the target month's length. */
export function addMonths(day: string, count: number): string {
  const date = toUtcMidnight(day);
  const targetMonth = date.getUTCMonth() + count;
  const dayOfMonth = date.getUTCDate();

  // Set the day to the 1st first: rolling 2026-01-31 forward one month would
  // otherwise land on 2026-03-03, skipping February entirely.
  date.setUTCDate(1);
  date.setUTCMonth(targetMonth);
  const lastOfTarget = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)
  ).getUTCDate();
  date.setUTCDate(Math.min(dayOfMonth, lastOfTarget));

  return toDayString(date);
}

/** The Monday of `day`'s week. */
export function startOfWeek(day: string): string {
  // getUTCDay(): Sunday = 0 … Saturday = 6 → days elapsed since this week's Monday.
  const daysSinceMonday = (toUtcMidnight(day).getUTCDay() + 6) % 7;
  return addDays(day, -daysSinceMonday);
}

/** The Sunday of `day`'s week. */
export function endOfWeek(day: string): string {
  return addDays(startOfWeek(day), 6);
}

/** The 1st of `day`'s month. */
export function startOfMonth(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

/** The last day of `day`'s month. */
export function endOfMonth(day: string): string {
  const date = toUtcMidnight(day);
  return toDayString(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)));
}

/** Whether two day strings fall in the same calendar month. */
export function isSameMonth(a: string, b: string): boolean {
  return a.slice(0, 7) === b.slice(0, 7);
}

/** A view the URL asked for, or the default for anything unrecognized. */
export function resolveCalendarView(raw: string | string[] | undefined): CalendarView {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return DEFAULT_CALENDAR_VIEW;

  const normalized = value.trim().toLowerCase();
  return (CALENDAR_VIEWS as readonly string[]).includes(normalized)
    ? (normalized as CalendarView)
    : DEFAULT_CALENDAR_VIEW;
}

/**
 * The day the calendar is anchored to.
 *
 * `today` is the caller's business-zone today (`appZoneToday`), and it is what an
 * absent or unusable `?date=` falls back to — a calendar that opened on a day
 * nobody named would be a calendar showing the wrong month with no way to tell.
 */
export function resolveCalendarAnchor(raw: string | string[] | undefined, today: string): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return today;

  const normalized = value.trim();
  return isCalendarDay(normalized) ? normalized : today;
}

export interface CalendarRange {
  view: CalendarView;
  /** The day the URL names — inside `days`, and what "this month" is measured against. */
  anchor: string;
  /** First day of the PERIOD (the Monday, or the 1st) — not necessarily `days[0]`. */
  periodStart: string;
  /** Last day of the period (the Sunday, or the month's last day). */
  periodEnd: string;
  /**
   * Every cell the grid draws, in order.
   *
   * For a month this is padded out to whole Monday–Sunday weeks, so the grid is
   * a rectangle: 35 or 42 days, the first and last few of which belong to the
   * neighbouring months. `isSameMonth(day, anchor)` is what tells them apart.
   */
  days: string[];
}

function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}

/** The period and grid for one view anchored on one day. */
export function buildCalendarRange(view: CalendarView, anchor: string): CalendarRange {
  if (view === "week") {
    const periodStart = startOfWeek(anchor);
    const periodEnd = endOfWeek(anchor);
    return { view, anchor, periodStart, periodEnd, days: daysBetween(periodStart, periodEnd) };
  }

  const periodStart = startOfMonth(anchor);
  const periodEnd = endOfMonth(anchor);
  return {
    view,
    anchor,
    periodStart,
    periodEnd,
    days: daysBetween(startOfWeek(periodStart), endOfWeek(periodEnd)),
  };
}

/**
 * Where Previous / Next land.
 *
 * A week moves by seven days and a month by one month, both from the ANCHOR
 * rather than from the grid — stepping by `days.length` would move a month view
 * by five or six weeks depending on how the padding fell, so pressing Next
 * twice could skip a month entirely.
 */
export function shiftCalendarAnchor(view: CalendarView, anchor: string, direction: -1 | 1): string {
  return view === "week" ? addDays(anchor, direction * 7) : addMonths(anchor, direction);
}

/**
 * The half-open instant window the visible days cover, on the business clock.
 *
 * `[first day 00:00, day after the last day 00:00)` — half-open so a post at
 * exactly midnight belongs to one day only, and derived through `appZoneInstant`
 * so the window is the company's days rather than UTC's. The two differ by two
 * or three hours, which is precisely the span in which an evening post would
 * otherwise be fetched for the wrong week.
 */
export function calendarWindowInstants(range: CalendarRange): { from: Date; to: Date } {
  const first = range.days[0];
  const afterLast = addDays(range.days[range.days.length - 1], 1);

  const from = appZoneInstant(first, 0, 0);
  const to = appZoneInstant(afterLast, 0, 0);

  // Both days come from arithmetic on validated day strings, so neither can be
  // unreal — but `appZoneInstant` is nullable and swallowing that would turn a
  // future bug into a silently empty calendar.
  if (from === null || to === null) {
    throw new Error(`Calendar range covers an unreal day: ${first} … ${afterLast}`);
  }

  return { from, to };
}

/**
 * The query string for a calendar view/anchor, preserving everything else in the
 * URL — the status filter and any parameter belonging to someone else.
 */
export function buildCalendarQuery(
  current: URLSearchParams | string,
  next: { view?: CalendarView; date?: string }
): string {
  const params = new URLSearchParams(current);
  if (next.view !== undefined) params.set(CALENDAR_VIEW_PARAM, next.view);
  if (next.date !== undefined) params.set(CALENDAR_DATE_PARAM, next.date);
  return params.toString();
}
