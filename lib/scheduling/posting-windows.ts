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

/** Used when a channel has no windows configured, or its JSON does not parse. */
export const DEFAULT_POSTING_HOUR = 10;

export interface TimeOfDay {
  hour: number;
  minute: number;
}

/**
 * The time of day a post lands on the given weekday.
 *
 * Falls back to the first configured window when that specific day has none —
 * a channel that posts only on weekdays should still place a Saturday post at
 * its usual hour rather than at an arbitrary default. With nothing configured
 * (or unparseable JSON) the answer is 10:00.
 *
 * `dayIndex` is an index into DAY_ORDER, i.e. 0 = Monday.
 */
export function resolveWindowStart(postingWindows: unknown, dayIndex: number): TimeOfDay {
  const parsed = postingWindowsSchema.safeParse(postingWindows);
  if (!parsed.success || parsed.data.length === 0) {
    return { hour: DEFAULT_POSTING_HOUR, minute: 0 };
  }

  const dayName = DAY_ORDER[dayIndex];
  const window = parsed.data.find((w) => w.day === dayName) ?? parsed.data[0];
  const [hour, minute] = window.start.split(":").map(Number);
  return { hour, minute };
}

/** DAY_ORDER index of a UTC date (0 = Monday), so windows can be looked up by it. */
export function utcDayIndex(date: Date): number {
  // getUTCDay(): Sunday = 0 … Saturday = 6 → Monday-first index
  return (date.getUTCDay() + 6) % 7;
}
