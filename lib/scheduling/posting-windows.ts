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
 * `dayIndex` is an index into DAY_ORDER, i.e. 0 = Monday.
 */
export function windowStartOn(windows: readonly PostingWindowEntry[], dayIndex: number): TimeOfDay {
  const dayName = DAY_ORDER[dayIndex];
  const window = windows.find((w) => w.day === dayName) ?? windows[0];
  const [hour, minute] = window.start.split(":").map(Number);
  return { hour, minute };
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
