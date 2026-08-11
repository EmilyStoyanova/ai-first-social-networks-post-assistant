/**
 * The times of day the UI offers when somebody picks a publish time.
 *
 * Publishing is a repeating sweep — Buffer is called with "share now", so a post
 * goes out on the first sweep at or after its own time (see publish-window.ts).
 * At a 30-minute cadence that makes 16:15 a time the system cannot keep: the
 * post is written for 16:15 and published at 16:30. Nothing is broken by it, but
 * the form promised a precision it does not have.
 *
 * So the pickers offer only the times a sweep can actually hit: 00:00, 00:30,
 * 01:00 … 23:30. `SLOT_MINUTES` is DERIVED from the sweep interval rather than
 * typed as 30, because the whole justification for the list is that it matches
 * the cadence — move the sweep to every 15 minutes and the pickers should follow
 * it in the same commit.
 *
 * A UI GUIDE, AND NOTHING MORE. The planner, `validateCustomDistribution` and
 * the reschedule API all still accept any real time of day, so posts already
 * scheduled at :15 keep their times, keep validating and keep publishing exactly
 * as they did. Nothing here migrates or rewrites anything; `slotOptions` exists
 * precisely so an existing off-slot time can still be shown as what it is.
 *
 * Pure, so the arithmetic — and especially the end-of-day clamp — is testable
 * without rendering a picker.
 */

import { PUBLISH_SWEEP_INTERVAL_MS } from "./publish-window";

const MINUTES_IN_DAY = 24 * 60;

/** Minutes between two consecutive publish sweeps, and so between two slots. */
export const SLOT_MINUTES = PUBLISH_SWEEP_INTERVAL_MS / 60_000;

/** 23:30 — the last slot a day has, in minutes past midnight. */
export const LAST_SLOT_MINUTES = MINUTES_IN_DAY - SLOT_MINUTES;

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * A `HH:mm` wall clock → minutes past midnight, or null when it is not a real
 * time of day. Range-checked, not merely shaped: `"25:70"` is not a time.
 */
export function timeToMinutes(value: string): number | null {
  const match = HH_MM.exec(value);
  return match === null ? null : Number(match[1]) * 60 + Number(match[2]);
}

/** Minutes past midnight → the `HH:mm` a picker shows. */
export function minutesToTime(minutes: number): string {
  const whole = Math.trunc(minutes);
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

/** Every offered time of day, `"00:00"` … `"23:30"`, in order. */
export const TIME_SLOTS: readonly string[] = Array.from(
  { length: MINUTES_IN_DAY / SLOT_MINUTES },
  (_, i) => minutesToTime(i * SLOT_MINUTES)
);

/** Whether a `HH:mm` is one of the offered slots. */
export function isSlotAligned(value: string): boolean {
  const minutes = timeToMinutes(value);
  return minutes !== null && minutes % SLOT_MINUTES === 0;
}

/**
 * Minutes past midnight, moved to a slot boundary.
 *
 * FORWARD, because that is the sweep that would have published the post anyway:
 * 16:15 is picked up at 16:30, so 16:30 is what the time already meant. Rounding
 * back would move the post earlier than the time it was given, which is the one
 * direction a schedule must never drift.
 *
 * Clamped at 23:30 rather than rolling into 00:00, so snapping can never move a
 * post onto a day nobody chose — the same rule the bulk planner's own overflow
 * follows. A 23:45 therefore comes back as 23:30, the only slot of that day that
 * is not in the future; callers are the ones that know whether an earlier time is
 * acceptable, and both the reschedule API and `validateCustomDistribution` refuse
 * a time in the past regardless.
 */
export function snapMinutesToSlot(minutes: number): number {
  if (!Number.isFinite(minutes)) return 0;
  const inDay = Math.max(0, Math.min(minutes, LAST_SLOT_MINUTES));
  return Math.min(LAST_SLOT_MINUTES, Math.ceil(inDay / SLOT_MINUTES) * SLOT_MINUTES);
}

/** A `HH:mm` moved to a slot boundary, or null when it is not a time of day. */
export function snapToSlot(value: string): string | null {
  const minutes = timeToMinutes(value);
  return minutes === null ? null : minutesToTime(snapMinutesToSlot(minutes));
}

/**
 * The options a slot picker should list in order to show `value`.
 *
 * Normally just `TIME_SLOTS`. An off-slot `value` is a post scheduled before this
 * rule existed, and it is added to the list in its chronological place: a select
 * whose value is absent from its options renders empty, which would read as the
 * time having been lost. Showing it is also the honest answer — that IS when the
 * post is scheduled, and it stays that way until somebody picks something else.
 */
export function slotOptions(value: string): readonly string[] {
  if (timeToMinutes(value) === null || isSlotAligned(value)) return TIME_SLOTS;
  // `HH:mm` sorts lexicographically exactly as it does chronologically.
  return [...TIME_SLOTS, value].sort();
}
