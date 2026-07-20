import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeMetrics, isEmptyMetrics, type BufferPostMetric } from "./metric-normalizer";

/**
 * Fixtures are the VERBATIM arrays Buffer returned on 2026-07-20 for real posts.
 * Keeping them exact is the point: the per-channel shape here is the evidence
 * that Facebook omits `reach` and Instagram omits `impressions`/`clicks`, which
 * is what the "absent means null" rule depends on.
 */

/** Facebook post 6a54ed64 — the only post with non-zero clicks/impressions. */
const FACEBOOK_WITH_DATA: BufferPostMetric[] = [
  { type: "reactions", name: "Reactions", value: 0, unit: "count" },
  { type: "comments", name: "Comments", value: 0, unit: "count" },
  { type: "engagementRate", name: "Eng. Rate", value: 12.5, unit: "percentage" },
  { type: "impressions", name: "Impressions", value: 8, unit: "count" },
  { type: "shares", name: "Shares", value: 0, unit: "count" },
  { type: "clicks", name: "Clicks", value: 1, unit: "count" },
];

/** Instagram post 6a4f855f — note reach/views/saves/follows, and no impressions. */
const INSTAGRAM_WITH_DATA: BufferPostMetric[] = [
  { type: "reactions", name: "Reactions", value: 1, unit: "count" },
  { type: "comments", name: "Comments", value: 0, unit: "count" },
  { type: "engagementRate", name: "Eng. Rate", value: 100, unit: "percentage" },
  { type: "views", name: "Views", value: 12, unit: "count" },
  { type: "shares", name: "Shares", value: 0, unit: "count" },
  { type: "saves", name: "Saves", value: 0, unit: "count" },
  { type: "follows", name: "Follows", value: 0, unit: "count" },
  { type: "reach", name: "Reach", value: 1, unit: "count" },
];

describe("normalizeMetrics — presence, not value, decides availability", () => {
  it("keeps a genuine zero as 0, not null", () => {
    const r = normalizeMetrics(FACEBOOK_WITH_DATA);
    // Facebook DID report these, and reported zero. That is a real result.
    assert.equal(r.reactions, 0);
    assert.equal(r.comments, 0);
    assert.equal(r.shares, 0);
  });

  it("maps a metric Facebook did not return to null, never 0", () => {
    const r = normalizeMetrics(FACEBOOK_WITH_DATA);
    // The whole point: absent from the array => unknown, not zero engagement.
    assert.equal(r.reach, null);
    assert.equal(r.views, null);
    assert.equal(r.saves, null);
    assert.equal(r.follows, null);
  });

  it("maps a metric Instagram did not return to null, never 0", () => {
    const r = normalizeMetrics(INSTAGRAM_WITH_DATA);
    assert.equal(r.impressions, null);
    assert.equal(r.clicks, null);
  });

  it("reads Facebook counts through", () => {
    const r = normalizeMetrics(FACEBOOK_WITH_DATA);
    assert.equal(r.impressions, 8);
    assert.equal(r.clicks, 1);
  });

  it("reads Instagram counts through", () => {
    const r = normalizeMetrics(INSTAGRAM_WITH_DATA);
    assert.equal(r.reactions, 1);
    assert.equal(r.reach, 1);
    assert.equal(r.views, 12);
  });
});

describe("normalizeMetrics — engagement rate", () => {
  it("takes Buffer's native Facebook rate and labels it impressions-based", () => {
    const r = normalizeMetrics(FACEBOOK_WITH_DATA);
    assert.equal(r.engagementRate, 12.5); // 1 click / 8 impressions
    assert.equal(r.engagementRateDenominator, "impressions");
  });

  it("takes Buffer's native Instagram rate and labels it reach-based", () => {
    const r = normalizeMetrics(INSTAGRAM_WITH_DATA);
    assert.equal(r.engagementRate, 100); // 1 reaction / 1 reach
    assert.equal(r.engagementRateDenominator, "reach");
  });

  it("never derives a rate Buffer did not supply", () => {
    // Reactions and reach are both present, so a rate COULD be computed — we
    // deliberately do not. Only Buffer's own number is ever shown.
    const r = normalizeMetrics([
      { type: "reactions", name: "Reactions", value: 5, unit: "count" },
      { type: "reach", name: "Reach", value: 100, unit: "count" },
    ]);
    assert.equal(r.engagementRate, null);
    assert.equal(r.engagementRateDenominator, null);
  });

  it("leaves the denominator null when Buffer sends a rate but no denominator metric", () => {
    const r = normalizeMetrics([
      { type: "engagementRate", name: "Eng. Rate", value: 4.2, unit: "percentage" },
    ]);
    assert.equal(r.engagementRate, 4.2);
    // Better an unlabelled rate than a wrongly-labelled one.
    assert.equal(r.engagementRateDenominator, null);
  });

  it("keeps a zero rate rather than treating it as missing", () => {
    // Three of the observed Facebook posts had exactly this.
    const r = normalizeMetrics([
      { type: "engagementRate", name: "Eng. Rate", value: 0, unit: "percentage" },
      { type: "impressions", name: "Impressions", value: 14, unit: "count" },
    ]);
    assert.equal(r.engagementRate, 0);
    assert.equal(r.engagementRateDenominator, "impressions");
  });
});

describe("normalizeMetrics — degenerate input", () => {
  it("returns all-null for an empty array", () => {
    const r = normalizeMetrics([]);
    assert.deepEqual(
      Object.values(r).filter((v) => v !== null),
      []
    );
  });

  it("returns all-null for null or undefined", () => {
    for (const input of [null, undefined]) {
      const r = normalizeMetrics(input);
      assert.equal(r.reactions, null);
      assert.equal(r.engagementRate, null);
    }
  });

  it("ignores metric types we do not model", () => {
    const r = normalizeMetrics([
      { type: "reactions", name: "Reactions", value: 3, unit: "count" },
      { type: "totalTimeWatched", name: "Watch time", value: 999, unit: "count" },
      { type: "quotes", name: "Quotes", value: 7, unit: "count" },
    ]);
    assert.equal(r.reactions, 3);
    // Unmodelled types must not crash; the raw array is preserved separately.
    assert.equal(Object.keys(r).length, 11);
  });

  it("rounds float artefacts instead of truncating", () => {
    const r = normalizeMetrics([
      { type: "reactions", name: "Reactions", value: 2.9999999, unit: "count" },
    ]);
    assert.equal(r.reactions, 3);
  });

  it("treats a non-finite count as unreported", () => {
    const r = normalizeMetrics([
      { type: "reactions", name: "Reactions", value: Number.NaN, unit: "count" },
    ]);
    assert.equal(r.reactions, null);
  });

  it("survives duplicate metric types by taking the last", () => {
    const r = normalizeMetrics([
      { type: "reactions", name: "Reactions", value: 1, unit: "count" },
      { type: "reactions", name: "Reactions", value: 9, unit: "count" },
    ]);
    assert.equal(r.reactions, 9);
  });
});

describe("isEmptyMetrics", () => {
  it("flags null, undefined, and empty arrays", () => {
    assert.equal(isEmptyMetrics(null), true);
    assert.equal(isEmptyMetrics(undefined), true);
    assert.equal(isEmptyMetrics([]), true);
  });

  it("does not flag an array of all-zero metrics", () => {
    // Post 6a5723 looked like this: reported, but every value zero. Real data.
    assert.equal(
      isEmptyMetrics([{ type: "reactions", name: "Reactions", value: 0, unit: "count" }]),
      false
    );
  });
});
