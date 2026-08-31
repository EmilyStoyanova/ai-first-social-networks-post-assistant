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
 *   1. every configured window that falls inside the period is opened out into
 *      candidate slots — one an hour, from its start, while still inside it,
 *   2. the ones that have already gone by are dropped, leaving the ELIGIBLE
 *      SLOTS,
 *   3. the requested posts are distributed evenly across that eligible list.
 *
 * So a channel configured for Tuesdays and Thursdays at 08:30 gets posts on
 * Tuesdays and Thursdays at 08:30 — never on the Sunday the range happens to
 * start on.
 *
 * THE ELIGIBLE SET IS FINITE, AND IT IS THE WHOLE ANSWER. Every instant this
 * mode can schedule comes out of `deriveEligibleSlots`; the planner only chooses
 * among them. It cannot borrow a time from a weekday the channel does not
 * publish on, cannot push a post past the end of the window it was planned into,
 * cannot invent an hour for a channel that has none, and cannot reach back into
 * a slot that has already gone by. When the request cannot be met from that set,
 * it is REFUSED — with which of the four reasons applies and the numbers behind
 * it — rather than met approximately:
 *
 *   • `NO_POSTING_WINDOWS` — the channel has no usable schedule at all. Configure
 *     one, or name the times yourself in custom mode.
 *   • `NO_POSTING_DAYS_IN_PERIOD` — it has one, but none of its weekdays occur in
 *     the period asked for (a Monday-only channel asked for Tue–Thu). This used
 *     to fall back to every day in the period at the channel's usual hour, which
 *     is precisely one weekday's window authorising another's.
 *   • `NO_FUTURE_POSTING_SLOTS` — the period does contain its posting days, but
 *     every slot on them is behind the clock. A period may start TODAY, and the
 *     window for today has usually already begun; the slots that have gone by
 *     used to be offered anyway, so a batch planned at 15:00 could be scheduled
 *     for 09:00 that morning and be past due before it was written.
 *   • `INSUFFICIENT_POSTING_SLOTS` — some slots remain, but fewer than the number
 *     of posts requested. This used to stack the surplus an hour at a time,
 *     walking straight out of the configured window and stopping only at 23:00.
 *     Asking for ten and silently getting six is not an option either: manual
 *     bulk writes the number of posts it was asked for, or says why not.
 *
 * See `planEvenDistribution`, which is the one entry point that answers all of
 * this — the form previews with it, the enqueue path validates with it, and the
 * worker schedules with it.
 *
 * NO INVENTED HOUR, ANYWHERE. Nothing in this module answers "when does this
 * channel publish?" with a time nobody chose. This is the manual half of the same
 * rule the weekly cron follows by skipping such a channel; the two paths differ
 * in what they DO about it, never in whether a time gets made up. They differ in
 * one more way, deliberately: the cron places at most one post per calendar day,
 * whereas manual bulk may fill several slots of one day — the user asked for a
 * specific number of posts over a specific period, and the window they configured
 * is how much room that day has.
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
import type { PostingDay, PostingWindowEntry, TimeOfDay } from "./posting-windows";
import { appZoneInstant, appZoneToday } from "./app-datetime-local";
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

/**
 * How far apart two publishing slots inside one posting window are.
 *
 * A window is a RANGE — "Fridays, 12:00 to 17:00" — so it has to be opened out
 * into the individual instants a post can actually be given. An hour is the
 * granularity the whole feature already reads in: it is what the old overflow
 * rule stepped by, it is what a channel's `postsPerWeek` implies about how often
 * a company wants to appear, and it keeps a five-hour window at five posts rather
 * than at ten half-hourly ones nobody asked for.
 *
 * The end is EXCLUSIVE: 12:00–17:00 offers 12:00, 13:00, 14:00, 15:00 and 16:00.
 * A post at 17:00 is a post at the moment the window shuts, and the same choice
 * is what makes two adjacent windows (09:00–12:00 and 12:00–15:00) describe one
 * unbroken run of slots rather than one that repeats at the seam.
 */
export const WINDOW_SLOT_MINUTES = 60;

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
  /**
   * The clock every candidate slot is measured against — a slot must be strictly
   * after it to be eligible.
   *
   * REQUIRED, and passed in rather than read here, for the reason every other
   * date rule in this module takes one (`isStartDateInPast`): the module is pure,
   * and a planner that read the clock itself would give a different answer every
   * time it ran, including between the preview the user approved and the batch
   * the worker wrote. Each caller supplies its own and each is right to: the form
   * uses the clock it opened on so a preview cannot change while being read, and
   * the enqueue path and the worker use their own — the server is the authority,
   * exactly as it already is for `START_DATE_IN_PAST` and `time_in_past`.
   */
  now: Date;
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

/** Minutes past midnight → the time of day they name. */
function minutesToTimeOfDay(minutes: number): TimeOfDay {
  return { hour: Math.floor(minutes / WINDOW_SLOT_MINUTES), minute: minutes % WINDOW_SLOT_MINUTES };
}

/**
 * Every minute-of-day a post may be published at inside ONE window: its start,
 * then each hour after it, while still short of its end.
 *
 * Empty when the start is not a time a clock can show. `postingWindowsSchema`
 * checks the SHAPE of a stored window, not its range, so a `"25:00"` parses and
 * is not a time — and a window with no readable start names no publishing time
 * at all.
 *
 * An unreadable or backwards END yields the start alone rather than nothing. The
 * settings form has required `start < end` since before this rule existed, so
 * this only ever meets rows written by something else; the start is still a time
 * its owner chose, and one slot at it is the narrowest honest reading. What it
 * must not do is guess an end and hand out slots the owner never authorised.
 */
function windowSlotMinutes(window: PostingWindowEntry): number[] {
  const start = timeToMinutes(window.start);
  if (start === null) return [];

  const end = timeToMinutes(window.end);
  if (end === null || end <= start) return [start];

  const minutes: number[] = [];
  for (let at = start; at < end; at += WINDOW_SLOT_MINUTES) minutes.push(at);
  return minutes;
}

/**
 * The channel's windows, keeping only the ones that name at least one publishing
 * time. Null when nothing usable is left.
 *
 * A channel whose only window is unusable gets the SAME answer as one that was
 * never configured: null. Neither is an hour a person can be said to have
 * chosen, so neither may be turned into one.
 */
function usableWindows(postingWindows: unknown): PostingWindowEntry[] | null {
  const parsed = parsePostingWindows(postingWindows);
  if (parsed === null) return null;

  const usable = parsed.filter((window) => windowSlotMinutes(window).length > 0);
  return usable.length > 0 ? usable : null;
}

/**
 * Times grouped by weekday, indexed by DAY_ORDER position (0 = Monday), with
 * `minutesOf` deciding which times a window contributes.
 *
 * Each day's times come out ascending and DISTINCT. Deduplication is what makes
 * overlapping windows behave: `09:00–12:00` beside `11:00–14:00` describes one
 * run of slots from 09:00 to 13:00, not a doubled 11:00 that would look twice as
 * available as it is and could take two posts at the same instant.
 *
 * Takes windows already filtered by `usableWindows`, so every empty day genuinely
 * has no window rather than an unreadable one.
 */
function timesByWeekday(
  windows: readonly PostingWindowEntry[],
  minutesOf: (window: PostingWindowEntry) => number[]
): TimeOfDay[][] {
  const byDay: number[][] = DAY_ORDER.map(() => []);
  for (const window of windows) {
    const day = byDay[DAY_ORDER.indexOf(window.day)];
    for (const minutes of minutesOf(window)) if (!day.includes(minutes)) day.push(minutes);
  }
  return byDay.map((day) => day.sort((a, b) => a - b).map(minutesToTimeOfDay));
}

/** Every instant-of-day this channel may publish at, per weekday. */
function eligibleTimesByWeekday(windows: readonly PostingWindowEntry[]): TimeOfDay[][] {
  return timesByWeekday(windows, windowSlotMinutes);
}

/**
 * The window START times, per weekday — what the CUSTOM editor's inputs open on.
 *
 * Deliberately not the eligible slots above: a seed says "this is the hour you
 * usually post at", and a five-hour window has one of those, not five. See
 * `defaultTimesForDay`.
 */
function windowStartsByWeekday(windows: readonly PostingWindowEntry[]): TimeOfDay[][] {
  return timesByWeekday(windows, (window) => {
    const start = timeToMinutes(window.start);
    return start === null ? [] : [start];
  });
}

/**
 * The weekdays this channel publishes on, Monday first — what a refusal names
 * back to the user so they can see why their period holds nothing.
 */
export function configuredPostingDays(postingWindows: unknown): PostingDay[] {
  const windows = usableWindows(postingWindows);
  if (windows === null) return [];
  return DAY_ORDER.filter((day) => windows.some((window) => window.day === day));
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
 * Every instant inside the period at which this channel is configured to
 * publish, earliest first — WITHOUT regard to whether it has already gone by.
 *
 * One slot per hour of each configured window, on each day of the period that
 * window's weekday falls on.
 *
 * STRICTLY THE CONFIGURED WEEKDAYS. A Monday window authorises Mondays. Asked
 * for a Tuesday–Thursday period, a Monday-only channel yields NOTHING — it does
 * not keep its usual hour and move it onto days it does not publish on, which is
 * what this used to do whenever no configured weekday occurred in the period.
 *
 * STRICTLY INSIDE THE WINDOWS, too: the last slot of a 12:00–17:00 window is
 * 16:00, and 17:00 is not eligible however many posts are asked for.
 *
 * DISTINCT INSTANTS. The dedupe in `timesByWeekday` works on wall clocks, which
 * is one instant short of enough: on the spring-forward day the skipped hour has
 * no instant of its own and `appZoneInstant` resolves it forward, so 03:00 and
 * 04:00 in Sofia on 2026-03-29 are the same moment. Two posts at one instant is
 * exactly what a custom distribution refuses as `duplicate_slot`, and the even
 * planner must not manufacture the situation to begin with.
 *
 * Not exported: what callers want is `deriveEligibleSlots`, which is this minus
 * the past. This exists separately only so `planEvenDistribution` can tell "the
 * period contains no posting day at all" from "it does, but the day is spent" —
 * two different problems with two different fixes.
 */
function configuredSlotsInPeriod(plan: BulkSlotPlan): Date[] {
  const days = inclusiveDayCount(plan.startDate, plan.endDate);
  const start = parseIsoDate(plan.startDate);
  if (days === null || start === null) return [];

  const windows = usableWindows(plan.postingWindows);
  if (windows === null) return [];

  // Days ascending, and each day's times already sorted — so this comes out
  // chronological without a second sort.
  const byDay = eligibleTimesByWeekday(windows);
  const slots: Date[] = [];
  const seen = new Set<number>();
  for (let offset = 0; offset < days; offset++) {
    const day = new Date(start.getTime() + offset * DAY_MS);
    for (const time of byDay[utcDayIndex(day)]) {
      const at = slotInstant(day, time);
      if (at === null || seen.has(at.getTime())) continue;
      seen.add(at.getTime());
      slots.push(at);
    }
  }

  return slots;
}

/**
 * Every instant inside the period at which this channel MAY STILL publish,
 * earliest first.
 *
 * This is the candidate set the requested posts are drawn from, and it is the
 * ONLY source of publishing instants this mode has: the configured slots of
 * `configuredSlotsInPeriod`, minus the ones already behind `plan.now`.
 *
 * THE PAST IS NOT A SCHEDULE. A bulk period may legitimately start today, and
 * the channel's window for today has very likely already begun — a five-hour
 * Friday window asked about at 15:00 has had four of its slots go by. Every slot
 * here becomes a real `Post.scheduledFor`, so keeping those would write drafts
 * that are past due the moment they exist: the publisher refuses to fire them
 * (lib/scheduling/publish-window.ts) and the user is left with a batch nobody
 * asked to be stranded. The comparison is on INSTANTS and is strict — see
 * `isStillAhead`.
 *
 * EMPTY WHEN THE CHANNEL HAS NO USABLE WINDOW, when no configured weekday occurs
 * in the period, and when every configured slot in it has gone by.
 * `planEvenDistribution` tells those three apart; here they are all simply "no
 * slot", because none of them is a time a post could be given.
 *
 * Also empty when the range itself is unusable — refused upstream as
 * `INVALID_DATE_RANGE`, and a range that names no days holds no slots either
 * way.
 */
export function deriveEligibleSlots(plan: BulkSlotPlan): Date[] {
  return configuredSlotsInPeriod(plan).filter((slot) => isStillAhead(slot, plan.now));
}

/**
 * Whether a slot is far enough ahead to be worth scheduling — STRICTLY after
 * `now`.
 *
 * Strict, so a slot falling on this very instant counts as gone: its publish
 * time would arrive before the post had been generated, let alone reviewed and
 * approved. There is no grace period in the other direction either, and
 * deliberately: a slot that has passed is not made available again by being only
 * a little bit past, and the honest answer to "there is no room left today" is
 * to say so rather than to schedule into a few minutes' time.
 *
 * Both sides are absolute instants, so the business zone and its DST changes are
 * already accounted for by the time this is asked — a 16:00 Sofia slot in August
 * is 13:00Z and is compared as such.
 */
function isStillAhead(slot: Date, now: Date): boolean {
  return slot.getTime() > now.getTime();
}

/** Why an even distribution cannot be planned, with the numbers behind it. */
export type BulkPlanProblem =
  /** No usable posting schedule at all. */
  | { code: "NO_POSTING_WINDOWS" }
  /** A schedule exists, but none of its weekdays occur in the chosen period. */
  | { code: "NO_POSTING_DAYS_IN_PERIOD"; days: PostingDay[] }
  /**
   * The period does contain the channel's posting days, but every slot on them
   * has already gone by.
   *
   * Its own code rather than a zero-availability `INSUFFICIENT_POSTING_SLOTS`,
   * because it is a different sentence to the person reading it: "there is no
   * room left in this period" is fixed by choosing a later one, whereas "there
   * is not enough room" is also fixed by asking for fewer posts — advice that
   * would be simply wrong here, since no number of posts fits.
   */
  | { code: "NO_FUTURE_POSTING_SLOTS" }
  /** The period holds fewer FUTURE publishing slots than posts were asked for. */
  | { code: "INSUFFICIENT_POSTING_SLOTS"; requested: number; available: number };

export type BulkPlanResult = { ok: true; slots: Date[] } | { ok: false; problem: BulkPlanProblem };

/**
 * The scheduled instants for one bulk run, earliest first — or why there are
 * none.
 *
 * THE one answer to "when would this batch publish?", shared by all three places
 * that need it: the form previews with it, the enqueue path refuses a request
 * with it, and the worker schedules from it. A second implementation anywhere is
 * how a preview starts lying and how an accepted request starts failing in a
 * worker log.
 *
 * The posts are spread evenly over the eligible slots by stratified sampling:
 * the eligible list is cut into `count` equal shares and each post takes the
 * slot at the centre of its share. Centres, not edges — that is precisely what
 * keeps the first and last posts off the boundaries of the period unless the
 * spread genuinely lands them there. (Three posts over a fortnight of daily
 * slots come out at roughly days 2, 7 and 12, not 1, 7 and 14.)
 *
 * With at least as many slots as posts, those share centres are strictly
 * increasing, so the chosen slots are DISTINCT and in order without any
 * collision rule — the shares are at least one slot wide, so no two centres can
 * land on the same one. That is why there is no longer an overflow rule to get
 * wrong: fewer slots than posts is refused rather than resolved.
 *
 * A non-positive or non-integer count plans nothing and reports it as the
 * shortfall it is; `validateBulkRequestShape` refuses it as `INVALID_POST_COUNT`
 * long before this, so it only has to be safe here.
 */
export function planEvenDistribution(plan: BulkSlotPlan): BulkPlanResult {
  if (usableWindows(plan.postingWindows) === null) {
    return { ok: false, problem: { code: "NO_POSTING_WINDOWS" } };
  }

  // Asked before the clock is applied, so "this period never contains a Friday"
  // stays distinguishable from "the Friday it contains is over".
  if (configuredSlotsInPeriod(plan).length === 0) {
    return {
      ok: false,
      problem: {
        code: "NO_POSTING_DAYS_IN_PERIOD",
        days: configuredPostingDays(plan.postingWindows),
      },
    };
  }

  const eligible = deriveEligibleSlots(plan);
  if (eligible.length === 0) {
    return { ok: false, problem: { code: "NO_FUTURE_POSTING_SLOTS" } };
  }

  const count = Number.isInteger(plan.count) ? plan.count : 0;
  if (count > eligible.length || count < 1) {
    return {
      ok: false,
      problem: {
        code: "INSUFFICIENT_POSTING_SLOTS",
        requested: plan.count,
        available: eligible.length,
      },
    };
  }

  const slots: Date[] = [];
  for (let i = 0; i < count; i++) {
    slots.push(eligible[Math.floor(((i + 0.5) * eligible.length) / count)]);
  }

  return { ok: true, slots };
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
  const configured = windowStartsByWeekday(windows)[dayIndex];
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
