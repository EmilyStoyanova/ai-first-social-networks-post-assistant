/**
 * The bits of the bulk generation form that are decisions rather than markup.
 *
 * Scheduling itself is NOT here — the form previews its slots by calling the
 * same `lib/scheduling/bulk-schedule.ts` planner the server schedules with, so
 * a preview cannot drift from what actually gets written. What lives here is
 * what the form needs around that planner: the range it opens on, the days it
 * offers in the custom editor, and how a finished batch reads back.
 *
 * Pure, so it can be tested without rendering anything.
 */

import {
  MAX_BULK_POSTS,
  defaultTimesForDay,
  type BulkCustomDay,
} from "@/lib/scheduling/bulk-schedule";
import { appZoneToday } from "@/lib/scheduling/app-datetime-local";

/** `YYYY-MM-DD` in UTC — the form's date format, and the API's. */
export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far ahead the default range ends, counted from its start. */
const DEFAULT_RANGE_DAYS = 13;

/**
 * The range the form opens on: tomorrow, through a fortnight.
 *
 * Tomorrow rather than today because a slot in the past is not a schedule — the
 * channel's window for today has very likely already passed by the time someone
 * is filling this in, and a post whose publish time is behind it reads as
 * broken. A fortnight is long enough that ten posts spread out sensibly and
 * short enough that the custom editor stays a list a person can read.
 *
 * "Tomorrow" is measured in the BUSINESS zone, like every other date this form
 * deals in. Measuring it in UTC would, for the three hours before midnight
 * Sofia, open the form on a day that is already today — the very thing this
 * function exists to avoid.
 */
export function defaultBulkRange(now: Date): { startDate: string; endDate: string } {
  // Midday, so adding whole days cannot be knocked onto a neighbouring date by a
  // DST shift; only the day part is ever read back.
  const start = new Date(`${appZoneToday(now)}T12:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() + 1);
  return {
    startDate: toIsoDate(start),
    endDate: toIsoDate(new Date(start.getTime() + DEFAULT_RANGE_DAYS * DAY_MS)),
  };
}

/**
 * Every day in the range, as `YYYY-MM-DD` — the rows of the custom editor.
 *
 * Empty when the range is unusable, so a backwards range renders no editor
 * rather than an editor that cannot be satisfied. `limit` caps how many rows
 * are offered: the period may legally run to a year, and nobody assigns ten
 * posts across 366 number inputs. The days past the cap stay valid dates, they
 * just are not offered — even distribution is the mode for a range that long.
 */
export function enumerateDays(startDate: string, endDate: string, limit = 62): string[] {
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return [];

  const days: string[] = [];
  for (let t = start; t <= end && days.length < limit; t += DAY_MS) {
    days.push(toIsoDate(new Date(t)));
  }
  return days;
}

/**
 * The editor's per-day counts and times as the API wants them: only the days
 * carrying at least one post, in date order, zeroes dropped.
 *
 * A day's times are cut to its count and never padded. Keeping the two in step
 * is `syncDayTimes`' job as the count field is edited; if they have come apart
 * anyway, this hands over what the state actually says and lets
 * `validateCustomDistribution` refuse it — a distribution quietly completed with
 * invented times is precisely what this mode must not do.
 */
export function toCustomDistribution(
  counts: Readonly<Record<string, number>>,
  times: Readonly<Record<string, string[]>>
): BulkCustomDay[] {
  return Object.entries(counts)
    .filter(([, count]) => Number.isInteger(count) && count > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count, times: (times[date] ?? []).slice(0, count) }));
}

/**
 * A day's list of times, resized to `count` — what the editor holds after its
 * per-day number has been typed into.
 *
 * Times the user has already chosen are KEPT, positionally: raising a day from
 * two posts to three must not renumber or re-seed the two times already on
 * screen, and lowering it back drops only the tail. New positions are seeded
 * from the channel's posting windows (`defaultTimesForDay`), so a day opens on
 * plausible hours rather than on empty inputs the user has to fill before
 * anything previews.
 */
export function syncDayTimes(
  date: string,
  count: number,
  existing: readonly string[] | undefined,
  postingWindows?: unknown
): string[] {
  if (!Number.isInteger(count) || count < 1) return [];

  const seeds = defaultTimesForDay(date, count, postingWindows);
  return Array.from(
    { length: count },
    // The last seed is the fallback for a position past the seeded list, which
    // only an unusable date can produce — `FALLBACK_TIME` then keeps the input
    // showing a real time instead of an empty one.
    (_, i) => existing?.[i] ?? seeds[i] ?? seeds[seeds.length - 1] ?? FALLBACK_TIME
  );
}

/** Shown when a day is too malformed to seed from; the API refuses it anyway. */
const FALLBACK_TIME = "10:00";

/** Total posts a custom distribution currently assigns. */
export function customTotal(counts: Readonly<Record<string, number>>): number {
  return Object.values(counts).reduce((sum, n) => sum + (Number.isFinite(n) ? n : 0), 0);
}

/**
 * Clamps a typed count to something the request could carry.
 *
 * `MAX_BULK_POSTS` per day is the real ceiling — a single day may hold the whole
 * batch — and anything unreadable becomes 0, which simply means "not this day".
 */
export function clampDayCount(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(parsed, MAX_BULK_POSTS);
}

// ─── Reading a finished batch ─────────────────────────────────────────────────

/** The batch summary as it crosses the wire — dates arrive as ISO strings. */
export interface BulkBatchResponse {
  batchId: string;
  requested: number;
  generated: number;
  failed: number;
  postIds: string[];
  posts: { index: number; postId: string; scheduledFor: string }[];
  failures: {
    index: number;
    scheduledFor: string;
    code: string;
    reason: string;
    message: string;
  }[];
  notAttempted: number;
  stoppedEarly: boolean;
  stopReason: "generation_failed" | "time_budget" | null;
}

/**
 * How a finished run should read to the person who started it.
 *
 *   • complete — every requested post exists.
 *   • partial  — some posts exist and the rest are explained.
 *
 * A run that produced nothing never reaches here: the API reports that as an
 * error with the generation's own code, so the form shows it the same way a
 * single generation failure is shown.
 */
export type BulkOutcome = "complete" | "partial";

export function bulkOutcome(batch: BulkBatchResponse): BulkOutcome {
  return batch.generated >= batch.requested ? "complete" : "partial";
}

/**
 * The translation key explaining why a partial run stopped, relative to the
 * `posts.generate.bulk` namespace.
 *
 * A failed slot is explained by the failure's own reason (the generation could
 * not find fresh material, the provider was down, and so on) because that is
 * what the user can act on. Running out of request time is not a content
 * problem at all and gets its own wording — "ask for the rest again", not
 * "add more sources".
 */
export function partialReasonKey(batch: BulkBatchResponse): string {
  if (batch.stopReason === "time_budget") return "stoppedTimeBudget";
  const reason = batch.failures[0]?.reason;
  return reason ? `stopped_${reason}` : "stoppedUnknown";
}
