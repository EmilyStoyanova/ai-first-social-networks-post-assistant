import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  INSUFFICIENT_POSTING_DAYS,
  isInsufficientPostingDays,
  upsertChannelConfigSchema,
} from "./channel-config.schema";

/** A valid channel edit — the fields the rule under test does not care about. */
const BASE = {
  enabled: true,
  postsPerDay: 1,
  postsPerWeek: 5,
  language: "inherit" as const,
  imageRequired: false,
  includeSourceLink: false,
  autoGenerateImage: false,
  automationModeOverride: null,
};

function window(day: string, start = "09:00") {
  return { day, start, end: "17:00" };
}

const WEEKDAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];

describe("upsertChannelConfigSchema — posting days must carry the weekly target", () => {
  it("rejects 5 posts a week with a single Friday window", () => {
    // The reported configuration. It used to save, and the cron then spread five
    // posts over five days using Friday's hour for four of them.
    const parsed = upsertChannelConfigSchema.safeParse({
      ...BASE,
      postingWindows: [window("FRIDAY", "12:00")],
    });

    assert.equal(parsed.success, false);
    assert.equal(isInsufficientPostingDays(parsed.error), true);
  });

  it("rejects 5 posts a week with four posting days", () => {
    const parsed = upsertChannelConfigSchema.safeParse({
      ...BASE,
      postingWindows: WEEKDAYS.slice(0, 4).map((d) => window(d)),
    });

    assert.equal(parsed.success, false);
    assert.equal(isInsufficientPostingDays(parsed.error), true);
  });

  it("accepts 5 posts a week with five posting days", () => {
    const parsed = upsertChannelConfigSchema.safeParse({
      ...BASE,
      postingWindows: WEEKDAYS.map((d) => window(d)),
    });

    assert.equal(parsed.success, true);
  });

  it("accepts one post a week with one posting day", () => {
    const parsed = upsertChannelConfigSchema.safeParse({
      ...BASE,
      postsPerWeek: 1,
      postingWindows: [window("FRIDAY", "12:00")],
    });

    assert.equal(parsed.success, true);
  });

  it("counts two windows on the same weekday as one posting day", () => {
    const parsed = upsertChannelConfigSchema.safeParse({
      ...BASE,
      postsPerWeek: 2,
      postingWindows: [window("MONDAY", "08:00"), window("MONDAY", "18:00")],
    });

    assert.equal(parsed.success, false);
    assert.equal(isInsufficientPostingDays(parsed.error), true);
  });

  it("still accepts a channel that takes no part in automatic generation", () => {
    // No windows at all is a supported, deliberate state — the channel is simply
    // never scheduled. Refusing it here would make every such channel unsavable
    // until its owner either invented a schedule or zeroed its weekly target.
    for (const postingWindows of [[], undefined]) {
      const parsed = upsertChannelConfigSchema.safeParse({ ...BASE, postingWindows });
      assert.equal(parsed.success, true, `${JSON.stringify(postingWindows)}`);
    }
  });

  it("reports an ordinary format error as something else entirely", () => {
    // The route maps our rule to its own error code, so it must not claim a
    // malformed time is a posting-day problem.
    const parsed = upsertChannelConfigSchema.safeParse({
      ...BASE,
      postsPerWeek: 1,
      postingWindows: [{ day: "MONDAY", start: "9:00", end: "17:00" }],
    });

    assert.equal(parsed.success, false);
    assert.equal(isInsufficientPostingDays(parsed.error), false);
  });

  it("names the rule with a stable code the route can map", () => {
    assert.equal(typeof INSUFFICIENT_POSTING_DAYS, "string");
    assert.ok(INSUFFICIENT_POSTING_DAYS.length > 0);
  });
});
