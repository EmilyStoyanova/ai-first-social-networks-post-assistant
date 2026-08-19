/**
 * Turning stored snapshots into a day-by-day series.
 *
 * ── The problem this module exists for ───────────────────────────────────────
 *
 * `PostMetricSnapshot` holds CUMULATIVE LIFETIME TOTALS. A post with 40
 * reactions on Monday and 46 on Tuesday did not attract 86 reactions — it
 * attracted 6 on Tuesday. Summing snapshot rows straight into a chart is
 * therefore not "roughly right", it is a number with no meaning at all, growing
 * with the length of the period rather than with engagement. Every rule below
 * follows from that one fact.
 *
 *  1. **Deltas, never totals.** A day's value is the difference between
 *     consecutive observations of the same post.
 *
 *  2. **The first observation of a post is not a day's activity.** It is
 *     everything the post had accumulated up to that moment. Where the post's
 *     publish day is known (always, on this page — the scope is posts published
 *     inside the period) that total is spread across the days it accumulated
 *     over, from publish day to first snapshot. Without a publish day it is a
 *     baseline and contributes nothing, which understates the first days but can
 *     never invent a spike.
 *
 *  3. **A gap is spread, not spiked.** The analytics cron reads a company's
 *     backlog over several runs, so a post is often observed every few days
 *     rather than daily. Attributing three days of engagement to the day we
 *     happened to look would draw a sawtooth that says more about our sync
 *     schedule than about the audience, so a delta is divided evenly across the
 *     days it actually covers.
 *
 *  4. **A day nobody observed is unknown, not zero.** Days no interval covers
 *     come back as `null`, and the chart breaks its line there. A sync outage
 *     rendered as a run of zeroes reads as "engagement stopped", which is a
 *     claim the data does not support.
 *
 *  5. **A metric a post never reported is skipped for that post**, not counted
 *     as zero — the same NULL ≠ 0 rule the rest of the dashboard runs on.
 *
 * Pure: day strings in, numbers out, no Prisma and no React.
 */

import { addDays } from "@/lib/calendar/calendar-range";

/** One stored observation of one metric, reduced to what the maths needs. */
export interface SeriesObservation {
  postId: string;
  /** Business-zone day of the snapshot, `YYYY-MM-DD`. */
  day: string;
  /** The cumulative value on that day. Null = this post never reported the metric. */
  value: number | null;
}

/** The publish day of each post in scope — rule 2's input. */
export interface SeriesPost {
  id: string;
  /** Business-zone day the post went out, `YYYY-MM-DD`. */
  publishedDay: string;
}

export interface DailyPoint {
  day: string;
  /** Engagement attributed to this day, or null when no observation covers it. */
  value: number | null;
}

export interface DailySeries {
  points: DailyPoint[];
  /** False when nothing in the period could be derived — the chart's empty state. */
  hasData: boolean;
}

interface SeriesInput {
  /** Every day of the period, ascending — from `buildAnalyticsRange`. */
  days: readonly string[];
  posts: readonly SeriesPost[];
  /** Observations of ONE metric, in any order. */
  observations: readonly SeriesObservation[];
}

/**
 * Adds `amount`, spread evenly, to every day in `[fromDay, toDay]`, and marks
 * those days observed.
 *
 * Marking happens even when `amount` is 0: a stretch we did observe and found
 * unchanged is a real zero, and it is the only thing that distinguishes a quiet
 * week from a week the sync never covered.
 */
function spread(
  totals: Map<string, number>,
  observed: Set<string>,
  fromDay: string,
  toDay: string,
  amount: number
): void {
  const span: string[] = [];
  for (let day = fromDay; day <= toDay; day = addDays(day, 1)) span.push(day);
  if (span.length === 0) return;

  const perDay = amount / span.length;
  for (const day of span) {
    observed.add(day);
    totals.set(day, (totals.get(day) ?? 0) + perDay);
  }
}

/**
 * The daily series for one metric.
 *
 * Rounded to two decimals on the way out: the spread in rule 3 produces thirds
 * and sevenths, and a chart tooltip reading "4.333333333333333 reactions" is
 * noise. Rounding at the end rather than per interval keeps the series' total
 * equal to the sum of the deltas that went into it.
 */
export function buildDailySeries({ days, posts, observations }: SeriesInput): DailySeries {
  const totals = new Map<string, number>();
  const observed = new Set<string>();

  const publishedDayOf = new Map(posts.map((p) => [p.id, p.publishedDay]));

  // One post's observations, newest last. A same-day duplicate cannot occur —
  // the store's @@unique([postId, snapshotAt]) makes a re-run update in place —
  // but grouping by day rather than by row keeps that an assumption we do not
  // depend on.
  const byPost = new Map<string, Map<string, number>>();
  for (const observation of observations) {
    // Rule 5: this post never reported this metric, so it has no series of its
    // own. Counting it as zero would drag every day's total down by a post the
    // network was not measuring.
    if (observation.value == null) continue;

    let dayValues = byPost.get(observation.postId);
    if (!dayValues) {
      dayValues = new Map();
      byPost.set(observation.postId, dayValues);
    }
    dayValues.set(observation.day, observation.value);
  }

  for (const [postId, dayValues] of byPost) {
    const entries = [...dayValues.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    const [firstDay, firstValue] = entries[0];
    const publishedDay = publishedDayOf.get(postId);

    // Rule 2. The post accumulated `firstValue` between going out and being
    // read for the first time, so that is the stretch it belongs to. A publish
    // day after the first snapshot would be incoherent data; the whole total
    // then lands on the snapshot day rather than on a reversed span.
    if (publishedDay !== undefined) {
      spread(
        totals,
        observed,
        publishedDay <= firstDay ? publishedDay : firstDay,
        firstDay,
        firstValue
      );
    }

    // Rule 1 and rule 3.
    for (let i = 1; i < entries.length; i++) {
      const [prevDay, prevValue] = entries[i - 1];
      const [day, value] = entries[i];

      // Cumulative totals should never fall. Buffer occasionally restates one
      // (a deleted comment, a recount), and a negative delta would draw a dip in
      // engagement that never happened — so a decrease contributes nothing while
      // still marking the span observed.
      const delta = Math.max(0, value - prevValue);
      spread(totals, observed, addDays(prevDay, 1), day, delta);
    }
  }

  const points = days.map((day) => ({
    day,
    // Rule 4: only a day an interval actually covered gets a number.
    value: observed.has(day) ? Math.round((totals.get(day) ?? 0) * 100) / 100 : null,
  }));

  return { points, hasData: points.some((point) => point.value != null) };
}
