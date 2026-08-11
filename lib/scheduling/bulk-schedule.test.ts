import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_BULK_POSTS,
  MAX_BULK_RANGE_DAYS,
  deriveEligibleSlots,
  inclusiveDayCount,
  isStartDateInPast,
  parseIsoDate,
  planBulkSlots,
  planCustomSlots,
  validateCustomDistribution,
} from "./bulk-schedule";
import { toAppDateTimeLocal } from "./app-datetime-local";

/** The worked example from the feature request. 2026-08-17 is a Monday. */
const START = "2026-08-17";
const END = "2026-08-30";

/**
 * `YYYY-MM-DDTHH:mm` on the BUSINESS clock — the whole of what a slot asserts.
 *
 * Deliberately not UTC: what a slot promises is a wall-clock time in the zone
 * the company works to, and that is the thing every expectation below is about.
 * `whenUtc` covers the other half — that the instant behind it is right, and
 * moves with the season.
 */
function stamp(date: Date): string {
  return toAppDateTimeLocal(date);
}

/** The same slot as the instant actually stored on the post. */
function whenUtc(date: Date): string {
  return date.toISOString();
}

/** Mon/Wed at 09:00 — a realistic two-day-a-week channel. */
const MON_WED = [
  { day: "MONDAY", start: "09:00", end: "11:00" },
  { day: "WEDNESDAY", start: "09:00", end: "11:00" },
];

describe("parseIsoDate", () => {
  it("reads a plain day as UTC midnight", () => {
    assert.equal(parseIsoDate("2026-08-17")?.toISOString(), "2026-08-17T00:00:00.000Z");
  });

  it("rejects anything that is not a bare YYYY-MM-DD", () => {
    for (const bad of ["", "2026-8-17", "17/08/2026", "2026-08-17T10:00:00Z", "tomorrow"]) {
      assert.equal(parseIsoDate(bad), null, bad);
    }
  });

  it("rejects a well-formed day that does not exist", () => {
    // Date() would silently roll this into March, which would schedule posts on
    // a day the user never named.
    assert.equal(parseIsoDate("2026-02-30"), null);
    assert.equal(parseIsoDate("2026-13-01"), null);
  });
});

describe("inclusiveDayCount", () => {
  it("counts both ends", () => {
    assert.equal(inclusiveDayCount("2026-08-17", "2026-08-17"), 1);
    assert.equal(inclusiveDayCount(START, END), 14);
  });

  it("refuses a backwards or unparseable range", () => {
    assert.equal(inclusiveDayCount("2026-08-30", "2026-08-17"), null);
    assert.equal(inclusiveDayCount(START, "not-a-date"), null);
  });

  it("refuses a period longer than the supported maximum", () => {
    // Slot derivation walks the period a day at a time, so an unbounded range is
    // an unbounded allocation inside a request handler.
    assert.equal(inclusiveDayCount("2026-01-01", "2026-12-31"), 365);
    assert.equal(inclusiveDayCount("2026-01-01", "2027-01-01"), MAX_BULK_RANGE_DAYS);
    assert.equal(inclusiveDayCount("2026-01-01", "2027-01-02"), null);
    assert.equal(inclusiveDayCount("2026-01-01", "9999-12-31"), null);
  });
});

describe("the times are business-zone wall clock, not UTC", () => {
  it("schedules a configured 18:30 at 18:30 in Sofia, whatever that is in UTC", () => {
    // The bug this exists to prevent: 18:30 stored as 18:30Z, then rendered back
    // to the user who typed it as 21:30.
    const summer = planCustomSlots(
      [{ date: "2026-08-17", count: 1 }],
      [{ day: "MONDAY", start: "18:30", end: "20:00" }]
    );
    assert.deepEqual(summer.map(stamp), ["2026-08-17T18:30"]);
    // EEST, UTC+3.
    assert.deepEqual(summer.map(whenUtc), ["2026-08-17T15:30:00.000Z"]);
  });

  it("follows the zone across the DST boundary rather than fixing an offset", () => {
    // Same configured time, opposite side of the year: the stored instant moves
    // by an hour so the wall clock does not.
    const winter = planCustomSlots(
      [{ date: "2026-01-19", count: 1 }],
      [{ day: "MONDAY", start: "18:30", end: "20:00" }]
    );
    assert.deepEqual(winter.map(stamp), ["2026-01-19T18:30"]);
    // EET, UTC+2.
    assert.deepEqual(winter.map(whenUtc), ["2026-01-19T16:30:00.000Z"]);
  });

  it("puts the default 10:00 on the business clock too", () => {
    const slots = planBulkSlots({ startDate: START, endDate: START, count: 1 });
    assert.deepEqual(slots.map(stamp), ["2026-08-17T10:00"]);
    assert.deepEqual(slots.map(whenUtc), ["2026-08-17T07:00:00.000Z"]);
  });

  it("keeps a slot on the day it was planned for, not the UTC day before it", () => {
    // 00:30 Sofia is 21:30 UTC the previous day. The post belongs to the 17th,
    // which is the day the user chose and the day the card will show.
    const slots = planCustomSlots(
      [{ date: "2026-08-17", count: 1 }],
      [{ day: "MONDAY", start: "00:30", end: "02:00" }]
    );
    assert.deepEqual(slots.map(stamp), ["2026-08-17T00:30"]);
    assert.deepEqual(slots.map(whenUtc), ["2026-08-16T21:30:00.000Z"]);
  });

  it("treats a window time that is not a real clock time as unconfigured", () => {
    // postingWindows is shape-checked, never range-checked. Rolling "25:00" over
    // into the next day would move the post off the day it was planned for.
    const slots = planCustomSlots(
      [{ date: "2026-08-17", count: 1 }],
      [{ day: "MONDAY", start: "25:00", end: "26:00" }]
    );
    assert.deepEqual(slots.map(stamp), ["2026-08-17T10:00"]);
  });
});

describe("isStartDateInPast", () => {
  /** 2026-08-17 11:00 UTC — 14:00 in Sofia, comfortably mid-afternoon. */
  const NOW = new Date("2026-08-17T11:00:00.000Z");

  it("allows today and anything after it", () => {
    assert.equal(isStartDateInPast("2026-08-17", NOW), false);
    assert.equal(isStartDateInPast("2026-08-18", NOW), false);
    assert.equal(isStartDateInPast("2027-01-01", NOW), false);
  });

  it("refuses a period that started yesterday or earlier", () => {
    assert.equal(isStartDateInPast("2026-08-16", NOW), true);
    assert.equal(isStartDateInPast("2025-12-31", NOW), true);
  });

  it("uses the business day, not the UTC day", () => {
    // 22:00 UTC on the 17th is already 01:00 on the 18th in Sofia, so the 17th
    // has gone by for the person filling in the form.
    const lateEvening = new Date("2026-08-17T22:00:00.000Z");
    assert.equal(isStartDateInPast("2026-08-17", lateEvening), true);
    assert.equal(isStartDateInPast("2026-08-18", lateEvening), false);
  });

  it("leaves an unusable date to the range check rather than claiming it is past", () => {
    assert.equal(isStartDateInPast("not-a-date", NOW), false);
    assert.equal(isStartDateInPast("2026-02-30", NOW), false);
  });
});

describe("deriveEligibleSlots — the channel's own posting days decide", () => {
  it("returns one slot per configured window inside the period", () => {
    const slots = deriveEligibleSlots({
      startDate: START,
      endDate: END,
      count: 3,
      postingWindows: MON_WED,
    });

    // Mondays 17 + 24, Wednesdays 19 + 26 — and NOTHING on any other weekday.
    assert.deepEqual(slots.map(stamp), [
      "2026-08-17T09:00",
      "2026-08-19T09:00",
      "2026-08-24T09:00",
      "2026-08-26T09:00",
    ]);
  });

  it("gives a day with two windows two slots, in time order", () => {
    const slots = deriveEligibleSlots({
      startDate: START,
      endDate: "2026-08-17",
      count: 1,
      // Deliberately out of order in the config; the output must not be.
      postingWindows: [
        { day: "MONDAY", start: "18:30", end: "20:00" },
        { day: "MONDAY", start: "07:15", end: "09:00" },
      ],
    });
    assert.deepEqual(slots.map(stamp), ["2026-08-17T07:15", "2026-08-17T18:30"]);
  });

  it("does not count a duplicated window twice", () => {
    const slots = deriveEligibleSlots({
      startDate: START,
      endDate: "2026-08-17",
      count: 1,
      postingWindows: [
        { day: "MONDAY", start: "09:00", end: "11:00" },
        { day: "MONDAY", start: "09:00", end: "12:00" },
      ],
    });
    assert.deepEqual(slots.map(stamp), ["2026-08-17T09:00"]);
  });

  it("falls back to every day at 10:00 when nothing is configured", () => {
    for (const windows of [undefined, [], { nonsense: true }]) {
      const slots = deriveEligibleSlots({
        startDate: START,
        endDate: "2026-08-19",
        count: 1,
        postingWindows: windows,
      });
      assert.deepEqual(slots.map(stamp), [
        "2026-08-17T10:00",
        "2026-08-18T10:00",
        "2026-08-19T10:00",
      ]);
    }
  });

  it("falls back to every day at the configured hour when no configured day occurs", () => {
    // A Monday-only channel asked for Tue–Thu. Generating nothing would be a
    // worse answer than posting off-schedule, so every day becomes eligible —
    // but at the channel's own 09:00, not at the 10:00 default.
    const slots = deriveEligibleSlots({
      startDate: "2026-08-18",
      endDate: "2026-08-20",
      count: 1,
      postingWindows: [{ day: "MONDAY", start: "09:00", end: "11:00" }],
    });
    assert.deepEqual(slots.map(stamp), [
      "2026-08-18T09:00",
      "2026-08-19T09:00",
      "2026-08-20T09:00",
    ]);
  });

  it("is empty only when the range itself is unusable", () => {
    assert.deepEqual(deriveEligibleSlots({ startDate: END, endDate: START, count: 1 }), []);
    assert.deepEqual(deriveEligibleSlots({ startDate: "nope", endDate: END, count: 1 }), []);
  });
});

describe("planBulkSlots — even spread, boundaries not pinned", () => {
  it("does not place posts on the start and end dates just to reach them", () => {
    const slots = planBulkSlots({ startDate: START, endDate: END, count: 5 });

    assert.equal(slots.length, 5);
    // 14 daily slots cut into 5 shares; each post takes its share's centre. The
    // range is used across its whole width without either boundary being an
    // implicit publishing date.
    assert.deepEqual(slots.map(stamp), [
      "2026-08-18T10:00",
      "2026-08-21T10:00",
      "2026-08-24T10:00",
      "2026-08-26T10:00",
      "2026-08-29T10:00",
    ]);
    assert.ok(!slots.some((s) => stamp(s).startsWith(START)), "nothing pinned to the start date");
    assert.ok(!slots.some((s) => stamp(s).startsWith(END)), "nothing pinned to the end date");
  });

  it("publishes only on the channel's configured days and times", () => {
    const slots = planBulkSlots({
      startDate: START,
      endDate: END,
      count: 3,
      postingWindows: MON_WED,
    });

    // Four eligible slots (Mon 17, Wed 19, Mon 24, Wed 26); three posts take the
    // centres of three equal shares of that list, so the whole period is covered
    // rather than the first three slots being filled and the tail left empty.
    // Every post is a Monday or a Wednesday at 09:00 — no other day is used.
    assert.deepEqual(slots.map(stamp), [
      "2026-08-17T09:00",
      "2026-08-24T09:00",
      "2026-08-26T09:00",
    ]);
  });

  it("never invents a publishing day the channel is not configured for", () => {
    const slots = planBulkSlots({
      startDate: START,
      endDate: END,
      count: MAX_BULK_POSTS,
      postingWindows: MON_WED,
    });

    const configuredDays = new Set([1, 3]); // Monday, Wednesday (getUTCDay)
    for (const slot of slots) {
      assert.ok(configuredDays.has(slot.getUTCDay()), `${stamp(slot)} is not a Mon/Wed`);
    }
  });

  it("puts a single post inside the period, not on its first day", () => {
    const slots = planBulkSlots({ startDate: START, endDate: END, count: 1 });
    // The centre of the one and only share — the middle of the period.
    assert.deepEqual(slots.map(stamp), ["2026-08-24T10:00"]);
  });

  it("uses every eligible slot when exactly as many are requested", () => {
    const eligible = deriveEligibleSlots({
      startDate: START,
      endDate: END,
      count: 4,
      postingWindows: MON_WED,
    });
    const slots = planBulkSlots({
      startDate: START,
      endDate: END,
      count: eligible.length,
      postingWindows: MON_WED,
    });
    assert.deepEqual(slots.map(stamp), eligible.map(stamp));
  });

  it("returns slots in ascending order", () => {
    for (const windows of [undefined, MON_WED]) {
      const slots = planBulkSlots({
        startDate: START,
        endDate: END,
        count: MAX_BULK_POSTS,
        postingWindows: windows,
      });
      for (let i = 1; i < slots.length; i++) {
        assert.ok(slots[i].getTime() > slots[i - 1].getTime(), `slot ${i} is not after ${i - 1}`);
      }
    }
  });

  describe("fallback — more posts than eligible slots", () => {
    it("stacks the extras an hour apart on the configured slots", () => {
      // One eligible slot in the whole period; three posts asked for.
      const slots = planBulkSlots({ startDate: START, endDate: START, count: 3 });
      assert.deepEqual(slots.map(stamp), [
        "2026-08-17T10:00",
        "2026-08-17T11:00",
        "2026-08-17T12:00",
      ]);
    });

    it("keeps the extras on the channel's configured days", () => {
      // Two eligible slots (Mon 17, Mon 24), five posts. Nothing moves onto a
      // day the channel does not post on — the extras stack on the Mondays.
      const slots = planBulkSlots({
        startDate: START,
        endDate: END,
        count: 5,
        postingWindows: [{ day: "MONDAY", start: "09:00", end: "11:00" }],
      });
      assert.deepEqual(slots.map(stamp), [
        "2026-08-17T09:00",
        "2026-08-17T10:00",
        "2026-08-24T09:00",
        "2026-08-24T10:00",
        "2026-08-24T11:00",
      ]);
    });

    it("is deterministic — the same plan always yields the same slots", () => {
      const plan = { startDate: START, endDate: END, count: 7, postingWindows: MON_WED };
      assert.deepEqual(planBulkSlots(plan).map(stamp), planBulkSlots(plan).map(stamp));
    });

    it("stops moving at 23:00 rather than spilling into the next day", () => {
      const slots = planBulkSlots({
        startDate: START,
        endDate: START,
        count: 3,
        postingWindows: [{ day: "MONDAY", start: "22:00", end: "23:30" }],
      });
      // Clamped, so two posts share 23:00 — but nothing leaves the day the user
      // asked for, and nothing is silently dropped.
      assert.deepEqual(slots.map(stamp), [
        "2026-08-17T22:00",
        "2026-08-17T23:00",
        "2026-08-17T23:00",
      ]);
    });
  });

  it("returns nothing for an invalid request rather than guessing", () => {
    assert.deepEqual(planBulkSlots({ startDate: START, endDate: END, count: 0 }), []);
    assert.deepEqual(planBulkSlots({ startDate: END, endDate: START, count: 3 }), []);
    assert.deepEqual(planBulkSlots({ startDate: "nope", endDate: END, count: 3 }), []);
    assert.deepEqual(
      planBulkSlots({ startDate: "2026-01-01", endDate: "2027-06-01", count: 3 }),
      []
    );
  });
});

describe("validateCustomDistribution", () => {
  it("accepts days inside the period whose counts add up", () => {
    assert.equal(
      validateCustomDistribution(
        [
          { date: "2026-08-18", count: 2 },
          { date: "2026-08-25", count: 1 },
        ],
        3,
        START,
        END
      ),
      null
    );
  });

  it("accepts the boundary days themselves — they are allowed, just not required", () => {
    assert.equal(validateCustomDistribution([{ date: START, count: 1 }], 1, START, END), null);
    assert.equal(validateCustomDistribution([{ date: END, count: 1 }], 1, START, END), null);
  });

  it("rejects a total that disagrees with the requested number of posts", () => {
    const days = [{ date: "2026-08-18", count: 2 }];
    assert.equal(validateCustomDistribution(days, 3, START, END), "count_mismatch");
    assert.equal(validateCustomDistribution(days, 1, START, END), "count_mismatch");
  });

  it("rejects an empty distribution", () => {
    assert.equal(validateCustomDistribution([], 3, START, END), "empty");
  });

  it("rejects a day outside the period", () => {
    assert.equal(
      validateCustomDistribution([{ date: "2026-09-01", count: 1 }], 1, START, END),
      "out_of_period"
    );
    assert.equal(
      validateCustomDistribution([{ date: "2026-08-16", count: 1 }], 1, START, END),
      "out_of_period"
    );
  });

  it("rejects an unusable period outright", () => {
    assert.equal(
      validateCustomDistribution([{ date: START, count: 1 }], 1, END, START),
      "out_of_period"
    );
    assert.equal(
      validateCustomDistribution([{ date: "2026-06-01", count: 1 }], 1, "2026-01-01", "2027-06-01"),
      "out_of_period"
    );
  });

  it("rejects a repeated day rather than quietly adding the two counts", () => {
    assert.equal(
      validateCustomDistribution(
        [
          { date: "2026-08-18", count: 1 },
          { date: "2026-08-18", count: 2 },
        ],
        3,
        START,
        END
      ),
      "duplicate_date"
    );
  });

  it("rejects a malformed date and a non-positive or fractional count", () => {
    assert.equal(
      validateCustomDistribution([{ date: "18/08/2026", count: 1 }], 1, START, END),
      "invalid_date"
    );
    assert.equal(
      validateCustomDistribution([{ date: "2026-08-18", count: 0 }], 0, START, END),
      "invalid_count"
    );
    assert.equal(
      validateCustomDistribution([{ date: "2026-08-18", count: 1.5 }], 1.5, START, END),
      "invalid_count"
    );
  });
});

describe("planCustomSlots — the user picks the days, the channel picks the times", () => {
  it("places each day's posts at that day's configured windows, in order", () => {
    const slots = planCustomSlots(
      [
        { date: "2026-08-17", count: 2 },
        { date: "2026-08-19", count: 1 },
      ],
      [
        { day: "MONDAY", start: "09:00", end: "10:00" },
        { day: "MONDAY", start: "18:30", end: "19:30" },
        { day: "WEDNESDAY", start: "12:15", end: "13:00" },
      ]
    );

    assert.deepEqual(slots.map(stamp), [
      "2026-08-17T09:00",
      "2026-08-17T18:30",
      "2026-08-19T12:15",
    ]);
  });

  it("fills the windows from the earliest one when a day has fewer posts than windows", () => {
    // The user asked for one post that day, so it goes at the first window —
    // not at whichever one an even spread would have centred on.
    const slots = planCustomSlots(
      [{ date: "2026-08-17", count: 1 }],
      [
        { day: "MONDAY", start: "09:00", end: "10:00" },
        { day: "MONDAY", start: "18:30", end: "19:30" },
      ]
    );
    assert.deepEqual(slots.map(stamp), ["2026-08-17T09:00"]);
  });

  it("stacks posts an hour apart past the last configured window", () => {
    const slots = planCustomSlots([{ date: "2026-08-17", count: 3 }], MON_WED);
    assert.deepEqual(slots.map(stamp), [
      "2026-08-17T09:00",
      "2026-08-17T10:00",
      "2026-08-17T11:00",
    ]);
  });

  it("keeps a day the channel has no window for at the channel's usual hour", () => {
    // Sunday on a Mon/Wed channel: the user explicitly chose the day, so it is
    // honoured — at 09:00, the channel's own time, not an arbitrary default.
    const slots = planCustomSlots([{ date: "2026-08-23", count: 1 }], MON_WED);
    assert.deepEqual(slots.map(stamp), ["2026-08-23T09:00"]);
  });

  it("falls back to 10:00 when the channel has no windows at all", () => {
    for (const windows of [undefined, [], { nonsense: true }]) {
      assert.deepEqual(planCustomSlots([{ date: "2026-08-18", count: 2 }], windows).map(stamp), [
        "2026-08-18T10:00",
        "2026-08-18T11:00",
      ]);
    }
  });

  it("returns the slots in ascending order whatever order the days arrive in", () => {
    const slots = planCustomSlots(
      [
        { date: "2026-08-26", count: 1 },
        { date: "2026-08-17", count: 2 },
        { date: "2026-08-19", count: 1 },
      ],
      MON_WED
    );
    assert.deepEqual(slots.map(stamp), [
      "2026-08-17T09:00",
      "2026-08-17T10:00",
      "2026-08-19T09:00",
      "2026-08-26T09:00",
    ]);
    for (let i = 1; i < slots.length; i++) {
      assert.ok(slots[i].getTime() > slots[i - 1].getTime());
    }
  });

  it("never lets one day's overflow push into the next day", () => {
    // Two posts on a 22:00 channel, on consecutive configured days: the second
    // post of day one is clamped at 23:00 and day two still starts at 22:00.
    const slots = planCustomSlots(
      [
        { date: "2026-08-17", count: 3 },
        { date: "2026-08-18", count: 1 },
      ],
      [
        { day: "MONDAY", start: "22:00", end: "23:30" },
        { day: "TUESDAY", start: "22:00", end: "23:30" },
      ]
    );
    assert.deepEqual(slots.map(stamp), [
      "2026-08-17T22:00",
      "2026-08-17T23:00",
      "2026-08-17T23:00",
      "2026-08-18T22:00",
    ]);
  });

  it("skips days it cannot use rather than guessing a date", () => {
    assert.deepEqual(planCustomSlots([]), []);
    assert.deepEqual(
      planCustomSlots([
        { date: "not-a-date", count: 2 },
        { date: "2026-08-18", count: 1 },
        { date: "2026-08-19", count: 0 },
      ]).map(stamp),
      ["2026-08-18T10:00"]
    );
  });
});
