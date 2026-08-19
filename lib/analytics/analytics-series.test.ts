import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDailySeries, type SeriesObservation, type SeriesPost } from "./analytics-series";

const DAYS = ["2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14"];

function observation(postId: string, day: string, value: number | null): SeriesObservation {
  return { postId, day, value };
}

/** A post with no publish day in range — forces the pure baseline path. */
const NO_POSTS: SeriesPost[] = [];

function valuesOf(series: ReturnType<typeof buildDailySeries>): Array<number | null> {
  return series.points.map((p) => p.value);
}

describe("buildDailySeries — cumulative totals become daily values", () => {
  it("takes the DIFFERENCE between consecutive snapshots, never their sum", () => {
    // 40 on the 11th and 46 on the 12th is 6 reactions on the 12th. Summing the
    // rows would say 86, a number that grows with the length of the period
    // rather than with engagement.
    const series = buildDailySeries({
      days: DAYS,
      posts: NO_POSTS,
      observations: [observation("p1", "2026-08-11", 40), observation("p1", "2026-08-12", 46)],
    });

    assert.deepEqual(valuesOf(series), [null, null, 6, null, null]);
  });

  it("treats a post's FIRST observation as a baseline, not as a day's activity", () => {
    // Its 40 reactions accumulated before we ever looked. Counting them as the
    // 11th's engagement would put a spike on the day of our first sync.
    const series = buildDailySeries({
      days: DAYS,
      posts: NO_POSTS,
      observations: [observation("p1", "2026-08-11", 40)],
    });

    assert.equal(series.hasData, false);
    assert.deepEqual(valuesOf(series), [null, null, null, null, null]);
  });

  it("adds up several posts on the same day", () => {
    const series = buildDailySeries({
      days: DAYS,
      posts: NO_POSTS,
      observations: [
        observation("p1", "2026-08-11", 10),
        observation("p1", "2026-08-12", 13),
        observation("p2", "2026-08-11", 100),
        observation("p2", "2026-08-12", 105),
      ],
    });

    assert.equal(series.points[2].value, 8);
  });
});

describe("buildDailySeries — gaps", () => {
  it("SPREADS a multi-day delta instead of spiking the day we looked", () => {
    // Read on the 11th and again on the 14th: 9 reactions arrived over three
    // days. Putting all nine on the 14th would draw a sawtooth that describes
    // our sync schedule rather than the audience.
    const series = buildDailySeries({
      days: DAYS,
      posts: NO_POSTS,
      observations: [observation("p1", "2026-08-11", 1), observation("p1", "2026-08-14", 10)],
    });

    assert.deepEqual(valuesOf(series), [null, null, 3, 3, 3]);
  });

  it("leaves an unobserved day NULL rather than zero", () => {
    // The 13th and 14th are past the last reading. A run of zeroes there would
    // read as "engagement stopped", which the data does not say.
    const series = buildDailySeries({
      days: DAYS,
      posts: NO_POSTS,
      observations: [observation("p1", "2026-08-11", 5), observation("p1", "2026-08-12", 9)],
    });

    assert.equal(series.points[3].value, null);
    assert.equal(series.points[4].value, null);
  });

  it("keeps an observed stretch with no movement as a real zero", () => {
    // We DID look, and nothing changed. That is the one thing that distinguishes
    // a quiet week from a week the sync never covered.
    const series = buildDailySeries({
      days: DAYS,
      posts: NO_POSTS,
      observations: [observation("p1", "2026-08-11", 7), observation("p1", "2026-08-12", 7)],
    });

    assert.equal(series.points[2].value, 0);
    assert.equal(series.hasData, true);
  });

  it("never draws a dip when Buffer restates a total downwards", () => {
    // A deleted comment can lower a cumulative figure. A negative delta would
    // show engagement being taken away on a day it was not.
    const series = buildDailySeries({
      days: DAYS,
      posts: NO_POSTS,
      observations: [observation("p1", "2026-08-11", 20), observation("p1", "2026-08-12", 15)],
    });

    assert.equal(series.points[2].value, 0);
  });
});

describe("buildDailySeries — a post's opening total", () => {
  it("spreads the first reading across the days since the post went out", () => {
    // Published on the 11th, first read on the 13th with 6 reactions: those six
    // arrived over the 11th, 12th and 13th, so two land on each.
    const series = buildDailySeries({
      days: DAYS,
      posts: [{ id: "p1", publishedDay: "2026-08-11" }],
      observations: [observation("p1", "2026-08-13", 6)],
    });

    assert.deepEqual(valuesOf(series), [null, 2, 2, 2, null]);
  });

  it("puts a same-day publish and reading entirely on that day", () => {
    const series = buildDailySeries({
      days: DAYS,
      posts: [{ id: "p1", publishedDay: "2026-08-12" }],
      observations: [observation("p1", "2026-08-12", 4)],
    });

    assert.deepEqual(valuesOf(series), [null, null, 4, null, null]);
  });

  it("does not reverse the span when the data is incoherent", () => {
    // A publish day after the first snapshot cannot happen; if it ever does, the
    // total lands on the snapshot day rather than producing a backwards range.
    const series = buildDailySeries({
      days: DAYS,
      posts: [{ id: "p1", publishedDay: "2026-08-14" }],
      observations: [observation("p1", "2026-08-11", 5)],
    });

    assert.deepEqual(valuesOf(series), [null, 5, null, null, null]);
  });

  it("carries on into ordinary deltas after the opening total", () => {
    const series = buildDailySeries({
      days: DAYS,
      posts: [{ id: "p1", publishedDay: "2026-08-11" }],
      observations: [
        observation("p1", "2026-08-11", 2),
        observation("p1", "2026-08-12", 5),
        observation("p1", "2026-08-13", 6),
      ],
    });

    assert.deepEqual(valuesOf(series), [null, 2, 3, 1, null]);
  });
});

describe("buildDailySeries — missing metrics and missing history", () => {
  it("skips a post that never reported the metric, rather than counting it as 0", () => {
    // p2's nulls must not drag the daily totals down: Instagram not measuring
    // impressions is not the same as measuring none.
    const series = buildDailySeries({
      days: DAYS,
      posts: NO_POSTS,
      observations: [
        observation("p1", "2026-08-11", 4),
        observation("p1", "2026-08-12", 10),
        observation("p2", "2026-08-11", null),
        observation("p2", "2026-08-12", null),
      ],
    });

    assert.equal(series.points[2].value, 6);
  });

  it("reports hasData false when nothing can be derived at all", () => {
    // One reading of one post: no pair, no publish day, so no day has a value.
    // This is what the chart's "not enough history yet" state is driven by.
    const series = buildDailySeries({
      days: DAYS,
      posts: NO_POSTS,
      observations: [observation("p1", "2026-08-12", 12)],
    });

    assert.equal(series.hasData, false);
    assert.deepEqual(valuesOf(series), [null, null, null, null, null]);
  });

  it("reports hasData false when there are no observations whatsoever", () => {
    const series = buildDailySeries({ days: DAYS, posts: NO_POSTS, observations: [] });

    assert.equal(series.hasData, false);
    assert.deepEqual(valuesOf(series), [null, null, null, null, null]);
  });

  it("collapses a repeated same-day reading rather than double counting", () => {
    // The store's unique index makes a same-day re-run update in place, so this
    // should not occur — but a duplicate must not be read as a day's worth of
    // extra engagement if it ever does.
    const series = buildDailySeries({
      days: DAYS,
      posts: NO_POSTS,
      observations: [
        observation("p1", "2026-08-11", 3),
        observation("p1", "2026-08-12", 5),
        observation("p1", "2026-08-12", 8),
      ],
    });

    assert.equal(series.points[2].value, 5);
  });

  it("ignores activity outside the plotted range", () => {
    // Deltas derived from days before the period still inform nothing inside it.
    const series = buildDailySeries({
      days: DAYS,
      posts: NO_POSTS,
      observations: [
        observation("p1", "2026-08-01", 1),
        observation("p1", "2026-08-02", 40),
        observation("p1", "2026-08-11", 44),
      ],
    });

    // The 08-02→08-11 delta of 4 is spread over nine days, so only the two that
    // fall inside the plotted range carry a value — and the 39 that landed on
    // 08-02 is nowhere in the series at all.
    assert.deepEqual(valuesOf(series), [0.44, 0.44, null, null, null]);
  });

  it("rounds a spread delta rather than carrying a repeating fraction", () => {
    // Two decimals: a tooltip reading "4.333333333333333 reactions" is noise.
    const series = buildDailySeries({
      days: DAYS,
      posts: NO_POSTS,
      observations: [observation("p1", "2026-08-11", 0), observation("p1", "2026-08-14", 10)],
    });

    assert.deepEqual(valuesOf(series), [null, null, 3.33, 3.33, 3.33]);
  });
});
