import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ANALYTICS_PERIODS,
  DEFAULT_ANALYTICS_PERIOD,
  analyticsPeriodQuery,
  analyticsWindowInstants,
  buildAnalyticsPeriodQuery,
  buildAnalyticsRange,
  resolveAnalyticsPeriod,
} from "./analytics-period";

describe("resolveAnalyticsPeriod", () => {
  it("accepts each period the filter offers", () => {
    for (const period of ANALYTICS_PERIODS) {
      assert.equal(resolveAnalyticsPeriod(period), period);
    }
  });

  it("defaults to 30 days when the URL says nothing", () => {
    assert.equal(DEFAULT_ANALYTICS_PERIOD, "30d");
    assert.equal(resolveAnalyticsPeriod(undefined), "30d");
    assert.equal(resolveAnalyticsPeriod(""), "30d");
  });

  it("falls back rather than throwing on anything unrecognised", () => {
    // Links outlive the code that made them: a period some future build offered
    // must land on data, not on a 404 or a crash.
    assert.equal(resolveAnalyticsPeriod("6m"), "30d");
    assert.equal(resolveAnalyticsPeriod("all-time"), "30d");
    assert.equal(resolveAnalyticsPeriod("../../etc"), "30d");
  });

  it("normalises case and stray whitespace", () => {
    assert.equal(resolveAnalyticsPeriod(" 7D "), "7d");
    assert.equal(resolveAnalyticsPeriod("3M"), "3m");
  });

  it("takes the first value of a repeated parameter", () => {
    assert.equal(resolveAnalyticsPeriod(["1y", "7d"]), "1y");
    assert.equal(resolveAnalyticsPeriod([]), "30d");
  });
});

describe("buildAnalyticsRange", () => {
  it("counts BOTH ends inclusively — 7 days means today and the six before", () => {
    const range = buildAnalyticsRange("7d", "2026-08-19");

    assert.equal(range.startDay, "2026-08-13");
    assert.equal(range.endDay, "2026-08-19");
    assert.equal(range.days.length, 7);
    assert.equal(range.days[0], "2026-08-13");
    assert.equal(range.days.at(-1), "2026-08-19");
  });

  it("covers exactly 30 days for the default period", () => {
    const range = buildAnalyticsRange("30d", "2026-08-19");

    assert.equal(range.startDay, "2026-07-21");
    assert.equal(range.days.length, 30);
  });

  it("steps 3 months by CALENDAR months, not by 90 days", () => {
    // Ending on the 19th, three months back is the 20th of May — so the range
    // starts on the day after the same day-of-month, however long those months
    // happened to be.
    const range = buildAnalyticsRange("3m", "2026-08-19");

    assert.equal(range.startDay, "2026-05-20");
    assert.equal(range.endDay, "2026-08-19");
  });

  it("steps 1 year by calendar months too", () => {
    const range = buildAnalyticsRange("1y", "2026-08-19");

    assert.equal(range.startDay, "2025-08-20");
    assert.equal(range.days.length, 365);
  });

  it("survives a leap day without losing or repeating one", () => {
    // 2028 is a leap year: a year back from 2028-03-01 must still be a contiguous
    // run of day strings with no gap at February's end.
    const range = buildAnalyticsRange("1y", "2028-03-01");

    assert.equal(range.days.length, 366);
    assert.equal(new Set(range.days).size, 366, "no day repeated");
    assert.ok(range.days.includes("2028-02-29"), "the leap day is in the range");
  });

  it("clamps a month step to the target month's length", () => {
    // Three months back from 31 May is 28 February, not 3 March.
    assert.equal(buildAnalyticsRange("3m", "2026-05-31").startDay, "2026-03-01");
  });

  it("produces a strictly ascending, contiguous day list", () => {
    const range = buildAnalyticsRange("30d", "2026-01-15");

    for (let i = 1; i < range.days.length; i++) {
      assert.ok(range.days[i] > range.days[i - 1], `${range.days[i]} follows ${range.days[i - 1]}`);
    }
    // Across a year boundary, which is where naive arithmetic breaks.
    assert.ok(range.days.includes("2025-12-31"));
    assert.ok(range.days.includes("2026-01-01"));
  });
});

describe("analyticsWindowInstants", () => {
  it("is half-open, so a midnight post belongs to one period only", () => {
    const range = buildAnalyticsRange("7d", "2026-08-19");
    const { from, to } = analyticsWindowInstants(range);

    assert.ok(from < to);
    // The upper bound is the START of the day after the last one, not its end.
    const next = analyticsWindowInstants(buildAnalyticsRange("7d", "2026-08-20"));
    assert.equal(to.getTime(), next.to.getTime() - 24 * 60 * 60 * 1000);
  });

  it("bounds the window on the BUSINESS clock, not on UTC", () => {
    // Europe/Sofia runs two or three hours ahead, so its midnight is the
    // previous UTC evening. A UTC-bounded window would put an evening post in
    // the wrong period for exactly those hours.
    const { from } = analyticsWindowInstants(buildAnalyticsRange("7d", "2026-08-19"));

    assert.notEqual(from.toISOString(), "2026-08-13T00:00:00.000Z");
    assert.equal(from.toISOString(), "2026-08-12T21:00:00.000Z");
  });

  it("spans a whole number of days for every period", () => {
    const day = 24 * 60 * 60 * 1000;
    for (const [period, days] of [
      ["7d", 7],
      ["30d", 30],
    ] as const) {
      const { from, to } = analyticsWindowInstants(buildAnalyticsRange(period, "2026-08-19"));
      assert.equal(to.getTime() - from.getTime(), days * day, period);
    }
  });
});

describe("period query strings", () => {
  it("states the period canonically for the channel switcher", () => {
    // This is what ChannelsShell carries across a channel change — without it,
    // switching from Facebook to Instagram would silently reset to 30 days.
    assert.equal(analyticsPeriodQuery("3m"), "period=3m");
  });

  it("preserves every other parameter already in the URL", () => {
    const next = buildAnalyticsPeriodQuery("period=7d&foo=bar", "1y");
    const params = new URLSearchParams(next);

    assert.equal(params.get("period"), "1y");
    assert.equal(params.get("foo"), "bar");
  });
});
