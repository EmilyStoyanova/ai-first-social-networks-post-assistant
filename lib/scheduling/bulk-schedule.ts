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
 * start on. See `deriveEligibleSlots` for what happens when the configured days
 * never occur in the period, and `planBulkSlots` for the fallback used when
 * there are fewer eligible slots than requested posts.
 *
 * NO INVENTED HOUR, ANYWHERE. Nothing in this module answers "when does this
 * channel publish?" with a time nobody chose. A channel with no usable posting
 * window plans NO eligible slots, and an even distribution over it comes back
 * empty — the caller reports that as `NO_POSTING_WINDOWS`
 * (lib/services/ai/validate-bulk-request.service.ts) so the user is told to
 * configure a schedule or to name the times themselves in custom mode. This is
 * the manual half of the same rule the weekly cron follows by skipping such a
 * channel; the two paths differ in what they DO about it, never in whether a
 * time gets made up.
 *
 * `planCustomSlots` is the other mode entirely, and the channel's windows have
 * no say in it: the user holds the calendar AND the clock, naming a time for
 * every single post. Nothing is derived there — the planner's whole job is to
 * turn the wall clocks the user typed into instants, in order. The windows are
 * still used to SEED those inputs (`defaultTimesForDay`), so the editor opens on
 * the channel's usual hours rather than on empty fields, but a seed is a starting
 * value the user can overwrite, not a schedule — and a channel with no windows
 * is seeded with nothing at all, leaving the inputs empty for the user to fill
 * rather than pre-filled with an hour the app chose. Both planners run unchanged in
 * the browser (to preview the dates before generating) and on the server (to
 * schedule them), which is why this module stays pure — a second implementation
 * in the form is exactly how a preview starts lying.
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

import { DAY_ORDER, parsePostingWindows, utcDayIndex, windowStartOn } from "./posting-windows";
import type { PostingWindowEntry, TimeOfDay } from "./posting-windows";
import { appZoneClock, appZoneInstant, appZoneToday } from "./app-datetime-local";
import {
  LAST_SLOT_MINUTES,
  SLOT_MINUTES,
  minutesToTime,
  snapMinutesToSlot,
  timeToMinutes,
} from "./time-slots";

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
  /**
   * `ChannelConfig.postingWindows` as stored.
   *
   * Absent, unparseable, or holding no usable time plans NOTHING: an even
   * distribution has no hour to distribute over, and one is not invented. The
   * caller turns the empty plan into `NO_POSTING_WINDOWS` rather than a batch
   * scheduled at a time nobody chose.
   */
  postingWindows?: unknown;
}

/**
 * One day of a user-authored distribution: "three posts on 2026-08-19, at
 * 09:00, 13:30 and 18:00".
 *
 * `count` and `times.length` say the same thing twice, and are required to
 * agree (`time_count_mismatch`) rather than one being derived from the other:
 * the count is what the editor's per-day field holds and what the request's
 * total is checked against, the times are what actually get scheduled, and a
 * request where they disagree is one whose author and reader would have
 * understood it differently.
 */
export interface BulkCustomDay {
  /** `YYYY-MM-DD`, read as UTC. */
  date: string;
  /** Posts to write on that day; at least 1, and exactly `times.length`. */
  count: number;
  /**
   * The publish time of each post on that day, as `HH:mm` — business-zone wall
   * clock, chosen by the user. Not optional, and never inferred: in this mode
   * the times ARE the request.
   */
  times: string[];
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

/** A window's start as a time of day. Shape-checked already; range-checked below. */
function windowStart(window: PostingWindowEntry): TimeOfDay {
  const [hour, minute] = window.start.split(":").map(Number);
  return { hour, minute };
}

/**
 * The channel's windows, keeping only the ones whose start is a real time of
 * day. Null when nothing usable is left.
 *
 * `postingWindowsSchema` checks the SHAPE of a stored window, not its range, so
 * a `"25:00"` parses and is not a time. Dropping those here means the rest of
 * the module works from times that exist, and — crucially — that a channel whose
 * only window is unusable gets the SAME answer as one that was never configured:
 * null. Neither is an hour a person can be said to have chosen, so neither may
 * be turned into one.
 */
function usableWindows(postingWindows: unknown): PostingWindowEntry[] | null {
  const parsed = parsePostingWindows(postingWindows);
  if (parsed === null) return null;

  const usable = parsed.filter((window) => isRealTimeOfDay(windowStart(window)));
  return usable.length > 0 ? usable : null;
}

/**
 * The channel's posting times grouped by weekday, indexed by DAY_ORDER position
 * (0 = Monday).
 *
 * A day may carry several windows (morning and evening, say); each becomes its
 * own eligible slot. Exact repeats are dropped so a duplicated window entry
 * cannot make one time of day look twice as available as it is.
 *
 * Takes windows already filtered by `usableWindows`, so every time it returns is
 * one a clock can show and every empty day genuinely has no window.
 */
function windowsByWeekday(windows: readonly PostingWindowEntry[]): TimeOfDay[][] {
  const byDay: TimeOfDay[][] = DAY_ORDER.map(() => []);
  for (const window of windows) {
    const { hour, minute } = windowStart(window);
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
 *
 * Null when the pair names no instant. Unreachable in practice — the day comes
 * from `parseIsoDate` and the time from `usableWindows` — and deliberately not
 * papered over with a substitute hour, because the only honest thing to do with
 * a slot that has no time is to not have the slot.
 */
function slotInstant(day: Date, time: TimeOfDay): Date | null {
  return appZoneInstant(day.toISOString().slice(0, 10), time.hour, time.minute);
}

/**
 * Every day in the period at that weekday's start time, falling back WITHIN the
 * channel's own schedule to its first configured window for a day that has none.
 */
function everyDayInPeriod(
  start: Date,
  days: number,
  windows: readonly PostingWindowEntry[]
): Date[] {
  const slots: Date[] = [];
  for (let offset = 0; offset < days; offset++) {
    const day = new Date(start.getTime() + offset * DAY_MS);
    const at = slotInstant(day, windowStartOn(windows, utcDayIndex(day)));
    if (at !== null) slots.push(at);
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
 * EMPTY WHEN THE CHANNEL HAS NO USABLE WINDOW, and that is the point. There is
 * no time to spread posts over, so none is chosen: the caller reports
 * `NO_POSTING_WINDOWS` and the user either configures a schedule or names the
 * times themselves in custom mode. This used to fall back to a fixed hour, which
 * meant a batch could be scheduled entirely at a time nobody had picked.
 *
 * One fallback remains, and it stays inside a schedule the user authored:
 * windows configured, but none of their weekdays occur in this period (a
 * Monday-only channel asked for a Tue–Thu range) — every day at the first
 * configured window's time, so the channel at least keeps its usual hour.
 * Honouring the days here would mean generating nothing at all, which is a worse
 * answer to "give me 5 posts next week" than posting off-schedule.
 *
 * Also empty when the range itself is unusable.
 */
export function deriveEligibleSlots(plan: BulkSlotPlan): Date[] {
  const days = inclusiveDayCount(plan.startDate, plan.endDate);
  const start = parseIsoDate(plan.startDate);
  if (days === null || start === null) return [];

  const windows = usableWindows(plan.postingWindows);
  if (windows === null) return [];

  // Days ascending, and each day's times already sorted — so this comes out
  // chronological without a second sort.
  const byDay = windowsByWeekday(windows);
  const configured: Date[] = [];
  for (let offset = 0; offset < days; offset++) {
    const day = new Date(start.getTime() + offset * DAY_MS);
    for (const time of byDay[utcDayIndex(day)]) {
      const at = slotInstant(day, time);
      if (at !== null) configured.push(at);
    }
  }

  return configured.length > 0 ? configured : everyDayInPeriod(start, days, windows);
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
 * Returns an empty array for a non-positive count, an unusable range, or a
 * channel with no usable posting window. Callers validate first and report a
 * proper error code — `NO_POSTING_WINDOWS` for the last of those — so this only
 * has to be safe, and never has to guess an hour to avoid coming back empty.
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
 * A `HH:mm` wall clock → its parts, or null when it is not a real time of day.
 *
 * Stricter than the shape check `postingWindowsSchema` applies to stored
 * windows: this reads times a user chose for a specific post, and there is no
 * sensible default to fall back to for a `"25:70"` — the request is simply wrong
 * and is refused (`invalid_time`).
 *
 * Note what is NOT checked: whether the time is one of the slots the pickers
 * offer (lib/scheduling/time-slots.ts). Slot alignment is a UI guide for new
 * choices, so a `16:15` — from a post scheduled before that guide existed, or
 * from an API client — stays a perfectly valid time here and everywhere below.
 */
export function parseTimeOfDay(value: string): TimeOfDay | null {
  const minutes = timeToMinutes(value);
  return minutes === null ? null : { hour: Math.floor(minutes / 60), minute: minutes % 60 };
}

/** A time of day → the `HH:mm` a time input shows and the request carries. */
export function formatTimeOfDay(time: TimeOfDay): string {
  return `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
}

/** Whether a time of day is one a clock can actually show. */
function isRealTimeOfDay(time: TimeOfDay): boolean {
  return (
    Number.isInteger(time.hour) &&
    Number.isInteger(time.minute) &&
    time.hour >= 0 &&
    time.hour <= LAST_HOUR_OF_DAY &&
    time.minute >= 0 &&
    time.minute <= 59
  );
}

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
  | "count_mismatch"
  | "invalid_time"
  | "time_count_mismatch"
  | "duplicate_slot"
  | "time_in_past";

/**
 * Checks a custom distribution against the request it belongs to, returning the
 * first problem found or null when it is usable.
 *
 * `total` is the requested number of posts: the per-day counts must add up to
 * exactly that, because the number the user asked for and the number the days
 * describe are the same number shown twice.
 *
 * `now` is what "in the past" is measured against, and is why this takes a clock
 * at all. In this mode the user names exact instants, so an instant already
 * behind them is a post the publisher will refuse to fire — caught here, while
 * it is still a form field, rather than after ten drafts have been written to
 * times that cannot happen. The form measures it against the clock it opened on
 * (so a field cannot start failing while being read) and the server against its
 * own; the server is the authority, so a form left open long enough for a chosen
 * time to go by is rejected on submit, which is the honest answer.
 */
export function validateCustomDistribution(
  days: readonly BulkCustomDay[],
  total: number,
  startDate: string,
  endDate: string,
  now: Date
): CustomDistributionError | null {
  if (days.length === 0) return "empty";

  const start = parseIsoDate(startDate);
  const end = parseIsoDate(endDate);
  if (start === null || end === null || inclusiveDayCount(startDate, endDate) === null) {
    return "out_of_period";
  }

  const seen = new Set<string>();
  // Every INSTANT the request has claimed so far. Two posts at one instant are
  // indistinguishable on the calendar and read as a mistake, so the second one is
  // refused rather than silently nudged an hour later — in this mode the times
  // are the user's, and moving one would be answering a question they did not
  // ask.
  //
  // Keyed on the resolved instant rather than on the `date` + `HH:mm` the user
  // typed, because those are not the same question one day a year: on the
  // spring-forward day the skipped hour has no instant of its own and resolves
  // forward, so 03:00 and 04:00 in Sofia on 2026-03-29 are one and the same
  // moment. Comparing the typed strings would call those distinct and write two
  // posts to the same instant — the exact thing this refuses.
  const slots = new Set<number>();
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
    if (!Array.isArray(day.times) || day.times.length !== day.count) return "time_count_mismatch";

    for (const raw of day.times) {
      const time = typeof raw === "string" ? parseTimeOfDay(raw) : null;
      if (time === null) return "invalid_time";

      // A real time on a real day can still name no instant — the hour a DST
      // jump skips. `appZoneInstant` resolves it forward rather than throwing,
      // but a null here means the pair was not usable at all.
      const at = appZoneInstant(day.date, time.hour, time.minute);
      if (at === null) return "invalid_time";
      if (at.getTime() <= now.getTime()) return "time_in_past";

      if (slots.has(at.getTime())) return "duplicate_slot";
      slots.add(at.getTime());
    }

    sum += day.count;
  }

  return sum === total ? null : "count_mismatch";
}

/**
 * The scheduled instants for a user-authored distribution, earliest first.
 *
 * The user chose everything: the days, how many posts each carries, and the
 * exact wall clock of every one of them. So this does no scheduling — it reads
 * `HH:mm` in the business zone and returns the instants those name, sorted.
 * Deliberately NOT taking the channel's posting windows: "Custom" means the
 * times on screen are the times that get written, and a planner that could
 * still move them is a planner whose preview is a guess.
 *
 * No overflow rule either, for the same reason: two posts wanting one instant is
 * refused up front (`duplicate_slot`) instead of one being pushed to an hour the
 * user never picked.
 *
 * Unusable days and times are skipped rather than guessed at; callers run
 * `validateCustomDistribution` first and report a proper error code.
 */
export function planCustomSlots(days: readonly BulkCustomDay[]): Date[] {
  const slots: Date[] = [];

  for (const day of days) {
    if (parseIsoDate(day.date) === null || !Array.isArray(day.times)) continue;

    for (const raw of day.times) {
      const time = typeof raw === "string" ? parseTimeOfDay(raw) : null;
      if (time === null) continue;

      const at = appZoneInstant(day.date, time.hour, time.minute);
      if (at !== null) slots.push(at);
    }
  }

  // Chronological regardless of the order the days and times arrived in: the
  // batch is generated slot by slot in this order, and both the preview and the
  // audit entry read it as "first post to last".
  return slots.sort((a, b) => a.getTime() - b.getTime());
}

/**
 * The `HH:mm` times a day's time inputs should OPEN on — `count` of them, in
 * ascending order, and distinct for as long as the day has room for them.
 *
 * A seed, not a schedule. The editor could open on empty fields and demand a
 * time for all ten posts before it previews anything, but the channel already
 * has usual hours and they are almost always what the user wants: this is the
 * old automatic behaviour, kept exactly where it belongs, as the starting value
 * of an input the user is free to overwrite.
 *
 * So a day's posts take that weekday's configured windows in order, and anything
 * past the last one steps on to the next slot — clamped at 23:30, because a
 * seeded time must not land on a day the user did not choose. A day with no
 * window of its own falls back to the channel's usual hour, which is still a
 * time out of the schedule its owner wrote.
 *
 * NOTHING TO SEED FROM IS AN EMPTY LIST, not a made-up hour. A channel with no
 * usable window returns `[]`, the editor's time inputs open EMPTY, and the user
 * picks. That is the whole difference between a seed and a default: a seed says
 * "this is probably what you want", and there is nothing to say that from here.
 * The request carrying an unfilled time is refused as `invalid_time`, by the
 * form and by the API alike, rather than quietly becoming a valid-looking
 * schedule at an hour nobody chose.
 *
 * EVERY SEED IS SLOT-ALIGNED (lib/scheduling/time-slots.ts), including one taken
 * from a window configured at 09:15: the editor's pickers offer only slots, so a
 * seed that is not one would be a starting value the user cannot get back to.
 * Stepping by one slot rather than by an hour comes from the same place, and it
 * also leaves a day room for more distinct seeds before the clamp.
 *
 * A day can run out of slots — ten posts seeded from a 22:00 window have only
 * four left — and past the clamp the seeds repeat. Nothing is lost: they are
 * starting values, `validateCustomDistribution` refuses the collision, and the
 * editor says so until the user spreads them out or moves some to another day.
 *
 * Pure wall-clock arithmetic: no zone is involved in "half an hour after 09:00",
 * and the times only become instants once `planCustomSlots` reads them.
 */
export function defaultTimesForDay(
  date: string,
  count: number,
  postingWindows?: unknown
): string[] {
  const day = parseIsoDate(date);
  if (day === null || !Number.isInteger(count) || count < 1) return [];

  // Nothing configured — or nothing configured that is a real time of day — so
  // there is no starting value to offer. The inputs open empty.
  const windows = usableWindows(postingWindows);
  if (windows === null) return [];

  const dayIndex = utcDayIndex(day);
  const configured = windowsByWeekday(windows)[dayIndex];
  const seeds = configured.length > 0 ? configured : [windowStartOn(windows, dayIndex)];

  const times: string[] = [];
  let previous = -1;

  for (let i = 0; i < count; i++) {
    const seed = seeds[Math.min(i, seeds.length - 1)];
    let minutes = snapMinutesToSlot(seed.hour * 60 + seed.minute);

    // Same shape as `pushPastPrevious`, at the sweep's granularity: the next slot
    // after the one already taken, and never past 23:30. A previous value is
    // always a slot, so adding one keeps it aligned.
    if (minutes <= previous) minutes = Math.min(previous + SLOT_MINUTES, LAST_SLOT_MINUTES);

    times.push(minutesToTime(minutes));
    previous = minutes;
  }

  return times;
}
