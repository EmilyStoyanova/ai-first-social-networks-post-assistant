/**
 * A channel's configured posting windows — the time of day it publishes.
 *
 * `ChannelConfig.postingWindows` is untyped JSON, so every reader has to parse
 * it defensively. This module is the one parser, shared by the weekly scheduler
 * (which spreads a week's posts) and manual bulk generation (which spreads a
 * requested date range). Two parsers would eventually disagree about what time
 * of day a channel posts, which is exactly the sort of drift a user notices
 * only after the posts are out.
 *
 * NO DEFAULT HOUR — HERE OR ANYWHERE ELSE. This module used to answer "10:00"
 * for a channel with no windows configured, and both callers took that answer.
 * The effect was that merely enabling a channel was enough to have the cron write
 * and schedule posts for it at an hour nobody had chosen. That is gone: with
 * nothing configured the answer is `null`, and each caller has to decide what
 * that means for it. Neither caller is allowed to decide "10:00":
 *
 *   • The weekly cron — the AUTOMATIC path — treats a channel with no windows as
 *     not scheduled at all and skips it. No window, no automatic generation, no
 *     automatically generated post. `hasPostingWindows` is that gate.
 *   • Manual bulk generation plans no slots for it and the request is refused as
 *     `NO_POSTING_WINDOWS`, which the form turns into "configure a schedule, or
 *     name the times yourself". Custom mode is that second door: there the user
 *     supplies every time and this module is not consulted for any of them.
 *
 * Manual SINGLE-post generation is untouched by all of this and always has been.
 * It has no distribution to plan — the user either names one publish time or
 * leaves the draft unscheduled — so it never asks this module anything and works
 * for a channel with no windows exactly as for one with them.
 *
 * WHAT A WINDOW TIME MEANS. `start` is a bare wall clock — "09:00" — and this
 * module returns it as one. Which zone that clock belongs to is the CALLER's
 * decision, and the two callers currently answer differently:
 *
 *   • Manual bulk generation reads it as business-zone (Europe/Sofia) wall
 *     clock, so a channel set to 18:30 publishes at 18:30 on the clock the user
 *     configured it on and the clock the post card reads back.
 *   • The weekly cron still applies it as UTC, unchanged. Its `scheduledFor` is
 *     an estimate that the publisher may act on up to 48 hours early anyway
 *     (lib/scheduling/publish-window.ts), so the offset is not observable in
 *     when those posts actually go out — whereas re-interpreting it would move
 *     every already-scheduled automatic post by two or three hours for no gain.
 *
 * That divergence is deliberate and is the whole reason it is written down here
 * rather than left to be discovered. Reconciling it means changing the automated
 * pipeline's timing, which is a product decision, not a refactor.
 *
 * Everything here is pure — no Prisma, no clock.
 */

import { z } from "zod";

/** Monday-first, matching how the windows are authored in channel settings. */
export const DAY_ORDER = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
] as const;

export type PostingDay = (typeof DAY_ORDER)[number];

export const postingWindowsSchema = z.array(
  z.object({
    day: z.enum(DAY_ORDER),
    start: z.string().regex(/^\d{2}:\d{2}$/),
    end: z.string().regex(/^\d{2}:\d{2}$/),
  })
);

/** One stored window, after parsing. Shape-checked, not range-checked. */
export type PostingWindowEntry = z.infer<typeof postingWindowsSchema>[number];

export interface TimeOfDay {
  hour: number;
  minute: number;
}

/**
 * The stored JSON as windows, or null when there is no usable schedule in it.
 *
 * Null covers both ways a channel can have nothing: no windows were ever saved,
 * and what was saved does not parse. They are the same answer on purpose —
 * neither is a schedule a person authored, and neither may be turned into one by
 * guessing.
 */
export function parsePostingWindows(postingWindows: unknown): PostingWindowEntry[] | null {
  const parsed = postingWindowsSchema.safeParse(postingWindows);
  return parsed.success && parsed.data.length > 0 ? parsed.data : null;
}

/**
 * Whether this channel has an explicitly configured posting schedule.
 *
 * THE gate for automatic generation: the weekly scheduler asks this before a
 * channel is given any part of a week, so a channel that is merely enabled never
 * produces an automatic post. Manual generation does not consult it.
 */
export function hasPostingWindows(postingWindows: unknown): boolean {
  return parsePostingWindows(postingWindows) !== null;
}

/**
 * The time of day a post lands on the given weekday, from windows already known
 * to be non-empty.
 *
 * Falls back to the first configured window when that specific day has none —
 * a channel that posts only on weekdays should still place a Saturday post at
 * its usual hour rather than at an arbitrary default. That is a fallback WITHIN
 * a schedule the user authored, not a substitute for one.
 *
 * NOT FOR SCHEDULING — AUTOMATIC OR MANUAL. The fallback answers "what time on
 * this day", which presumes the day was already decided legitimately. Both
 * schedulers used to decide days for themselves and then ask this, and the
 * fallback then made one Friday window authorise posts on other weekdays:
 *
 *   • the weekly cron spread its target across all seven days — it now takes its
 *     days from `postingDaySlots`;
 *   • manual bulk fell back to every day in the requested period whenever no
 *     configured weekday occurred in it — it now derives a finite eligible set
 *     from the windows themselves (`deriveEligibleSlots` in bulk-schedule.ts) and
 *     refuses the request rather than borrowing a weekday.
 *
 * What is left is SEEDING the custom bulk editor's time inputs
 * (`defaultTimesForDay`), where the user has chosen the day and this only offers
 * a starting value for a field they can overwrite. A seed is not a schedule.
 *
 * `dayIndex` is an index into DAY_ORDER, i.e. 0 = Monday.
 */
export function windowStartOn(windows: readonly PostingWindowEntry[], dayIndex: number): TimeOfDay {
  const dayName = DAY_ORDER[dayIndex];
  const window = windows.find((w) => w.day === dayName) ?? windows[0];
  const [hour, minute] = window.start.split(":").map(Number);
  return { hour, minute };
}

/** A weekday this channel publishes on, and the time of day it publishes at. */
export interface PostingDaySlot {
  /** Index into DAY_ORDER — 0 = Monday. */
  dayIndex: number;
  time: TimeOfDay;
}

/**
 * The days an automatic post may actually land on, Monday first.
 *
 * One slot per DISTINCT configured weekday, carrying that day's own start time.
 * This is the answer `windowStartOn` cannot give: it is asked about a day
 * somebody else chose and has to answer something, whereas this is asked which
 * days were chosen at all.
 *
 * That difference is the whole fix. The weekly cron used to spread its posts
 * evenly over all seven days and ask `windowStartOn` for each one, so a channel
 * configured for FRIDAY alone had posts placed on Monday, Tuesday, Wednesday and
 * Saturday, every one of them stamped with Friday's hour. A window authorises
 * its OWN weekday and no other; the cron now takes its days from here.
 *
 * Several windows on one weekday collapse to that day's first, because
 * automatic scheduling places at most one post per calendar day. The first in
 * saved order rather than the earliest by clock: it is the one `windowStartOn`
 * has always returned for that day, so a schedule that was already valid keeps
 * the exact times it had.
 */
export function postingDaySlots(windows: readonly PostingWindowEntry[]): PostingDaySlot[] {
  const slots: PostingDaySlot[] = [];

  for (let dayIndex = 0; dayIndex < DAY_ORDER.length; dayIndex++) {
    const window = windows.find((w) => w.day === DAY_ORDER[dayIndex]);
    if (!window) continue;

    const [hour, minute] = window.start.split(":").map(Number);
    slots.push({ dayIndex, time: { hour, minute } });
  }

  return slots;
}

/**
 * Whether a channel's configured days can carry its weekly target.
 *
 * THE configuration rule, and the reason a channel can no longer be saved
 * asking for five posts a week with one posting day. Automatic scheduling
 * places at most one post per calendar day, so N posts a week need N distinct
 * days — anything less used to be resolved by publishing on days nobody
 * configured.
 *
 * Two states are deliberately exempt, and neither is a loophole:
 *
 *   • NO WINDOWS AT ALL. That is the explicit "this channel takes no part in
 *     automatic generation" state the whole module is built around: it is gated
 *     by `hasPostingWindows` long before anything is scheduled, so no post can
 *     be placed on an unconfigured day by way of it. Refusing it here would also
 *     make every such channel unsavable until its owner either invented a
 *     schedule or zeroed its weekly target.
 *   • NO WEEKLY TARGET. Nothing is asked for, so no days are needed.
 *
 * The target is capped at the length of a week before comparing, since a stored
 * `postsPerWeek` of 100 cannot ask for more than seven days however it is
 * counted. That bound is the week itself, not a tunable ceiling.
 */
export function postingDaysCoverTarget(postsPerWeek: number, postingWindows: unknown): boolean {
  if (postsPerWeek <= 0) return true;

  const windows = parsePostingWindows(postingWindows);
  if (windows === null) return true;

  return postingDaySlots(windows).length >= Math.min(postsPerWeek, DAY_ORDER.length);
}

/**
 * `windowStartOn` straight off the stored JSON — null when nothing is
 * configured, which callers must handle rather than paper over.
 */
export function resolveWindowStart(postingWindows: unknown, dayIndex: number): TimeOfDay | null {
  const windows = parsePostingWindows(postingWindows);
  return windows === null ? null : windowStartOn(windows, dayIndex);
}

/** DAY_ORDER index of a UTC date (0 = Monday), so windows can be looked up by it. */
export function utcDayIndex(date: Date): number {
  // getUTCDay(): Sunday = 0 … Saturday = 6 → Monday-first index
  return (date.getUTCDay() + 6) % 7;
}
