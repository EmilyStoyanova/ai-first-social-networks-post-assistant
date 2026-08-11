import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_BULK_POSTS,
  MAX_BULK_RANGE_DAYS,
  defaultTimesForDay,
  deriveEligibleSlots,
  formatTimeOfDay,
  inclusiveDayCount,
  isStartDateInPast,
  parseIsoDate,
  parseTimeOfDay,
  planBulkSlots,
  planCustomSlots,
  validateCustomDistribution,
} from "./bulk-schedule";
import { toAppDateTimeLocal } from "./app-datetime-local";
import { isSlotAligned } from "./time-slots";

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
  it("schedules a chosen 18:30 at 18:30 in Sofia, whatever that is in UTC", () => {
    // The bug this exists to prevent: 18:30 stored as 18:30Z, then rendered back
    // to the user who typed it as 21:30.
    const summer = planCustomSlots([{ date: "2026-08-17", count: 1, times: ["18:30"] }]);
    assert.deepEqual(summer.map(stamp), ["2026-08-17T18:30"]);
    // EEST, UTC+3.
    assert.deepEqual(summer.map(whenUtc), ["2026-08-17T15:30:00.000Z"]);
  });

  it("follows the zone across the DST boundary rather than fixing an offset", () => {
    // Same chosen time, opposite side of the year: the stored instant moves by an
    // hour so the wall clock does not.
    const winter = planCustomSlots([{ date: "2026-01-19", count: 1, times: ["18:30"] }]);
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
    const slots = planCustomSlots([{ date: "2026-08-17", count: 1, times: ["00:30"] }]);
    assert.deepEqual(slots.map(stamp), ["2026-08-17T00:30"]);
    assert.deepEqual(slots.map(whenUtc), ["2026-08-16T21:30:00.000Z"]);
  });

  it("seeds from a window time that is not a real clock time as if unconfigured", () => {
    // postingWindows is shape-checked, never range-checked. A "25:00" must not
    // become a seeded input the API then refuses as invalid_time.
    assert.deepEqual(
      defaultTimesForDay("2026-08-17", 1, [{ day: "MONDAY", start: "25:00", end: "26:00" }]),
      ["10:00"]
    );
  });

  it("reads a chosen time back as itself, on every screen that shows it", () => {
    // The contract the whole mode depends on. `toAppDateTimeLocal` is what the
    // reschedule input is filled from, and `formatDateTime` renders the preview
    // and the post card through the same zone — so if the wall clock survives
    // this round trip, all three agree with what the user picked.
    //
    // Both sides of the DST boundary, and both edges of the day, because those
    // are where an offset bug hides: 00:15 and 23:45 are the times that would
    // land on a neighbouring DATE if the instant were assembled in UTC.
    for (const date of ["2026-01-19", "2026-08-17", "2026-03-29", "2026-10-25"]) {
      for (const time of ["00:15", "09:00", "13:15", "23:45"]) {
        const [slot] = planCustomSlots([{ date, count: 1, times: [time] }]);
        assert.equal(toAppDateTimeLocal(slot), `${date}T${time}`, `${date} ${time}`);
      }
    }
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

describe("parseTimeOfDay / formatTimeOfDay", () => {
  it("reads a real HH:mm", () => {
    assert.deepEqual(parseTimeOfDay("00:00"), { hour: 0, minute: 0 });
    assert.deepEqual(parseTimeOfDay("09:05"), { hour: 9, minute: 5 });
    assert.deepEqual(parseTimeOfDay("23:59"), { hour: 23, minute: 59 });
  });

  it("rejects anything a clock cannot show", () => {
    // Range-checked, unlike the shape check applied to stored posting windows:
    // these are times a user typed for a specific post.
    for (const bad of ["24:00", "25:00", "12:60", "9:00", "09:0", "0900", "", "09:00:00", "abc"]) {
      assert.equal(parseTimeOfDay(bad), null, bad);
    }
  });

  it("round-trips through formatTimeOfDay", () => {
    for (const value of ["00:00", "07:45", "18:30", "23:59"]) {
      assert.equal(formatTimeOfDay(parseTimeOfDay(value)!), value);
    }
  });
});

describe("validateCustomDistribution", () => {
  /** Well before every date used below, so nothing is accidentally "past". */
  const NOW = new Date("2026-08-10T09:00:00.000Z");

  /** A day with `count` posts at plausible distinct times. */
  function day(date: string, count: number) {
    return { date, count, times: defaultTimesForDay(date, count) };
  }

  it("accepts days inside the period whose counts add up and whose times are real", () => {
    assert.equal(
      validateCustomDistribution(
        [
          { date: "2026-08-18", count: 2, times: ["09:00", "17:30"] },
          { date: "2026-08-25", count: 1, times: ["12:00"] },
        ],
        3,
        START,
        END,
        NOW
      ),
      null
    );
  });

  it("accepts the boundary days themselves — they are allowed, just not required", () => {
    assert.equal(validateCustomDistribution([day(START, 1)], 1, START, END, NOW), null);
    assert.equal(validateCustomDistribution([day(END, 1)], 1, START, END, NOW), null);
  });

  it("rejects a total that disagrees with the requested number of posts", () => {
    const days = [day("2026-08-18", 2)];
    assert.equal(validateCustomDistribution(days, 3, START, END, NOW), "count_mismatch");
    assert.equal(validateCustomDistribution(days, 1, START, END, NOW), "count_mismatch");
  });

  it("rejects an empty distribution", () => {
    assert.equal(validateCustomDistribution([], 3, START, END, NOW), "empty");
  });

  it("rejects a day outside the period", () => {
    assert.equal(
      validateCustomDistribution([day("2026-09-01", 1)], 1, START, END, NOW),
      "out_of_period"
    );
    assert.equal(
      validateCustomDistribution([day("2026-08-16", 1)], 1, START, END, NOW),
      "out_of_period"
    );
  });

  it("rejects an unusable period outright", () => {
    assert.equal(validateCustomDistribution([day(START, 1)], 1, END, START, NOW), "out_of_period");
    assert.equal(
      validateCustomDistribution([day("2026-06-01", 1)], 1, "2026-01-01", "2027-06-01", NOW),
      "out_of_period"
    );
  });

  it("rejects a repeated day rather than quietly adding the two counts", () => {
    assert.equal(
      validateCustomDistribution(
        [
          { date: "2026-08-18", count: 1, times: ["09:00"] },
          { date: "2026-08-18", count: 2, times: ["12:00", "15:00"] },
        ],
        3,
        START,
        END,
        NOW
      ),
      "duplicate_date"
    );
  });

  it("rejects a malformed date and a non-positive or fractional count", () => {
    assert.equal(
      validateCustomDistribution(
        [{ date: "18/08/2026", count: 1, times: ["09:00"] }],
        1,
        START,
        END,
        NOW
      ),
      "invalid_date"
    );
    assert.equal(
      validateCustomDistribution([{ date: "2026-08-18", count: 0, times: [] }], 0, START, END, NOW),
      "invalid_count"
    );
    assert.equal(
      validateCustomDistribution(
        [{ date: "2026-08-18", count: 1.5, times: ["09:00"] }],
        1.5,
        START,
        END,
        NOW
      ),
      "invalid_count"
    );
  });

  // ── The rules the manual times add ────────────────────────────────────────

  it("requires exactly one time per post on the day", () => {
    // Fewer, and a post has no time; more, and a time belongs to no post. Either
    // way the request means two different things to its author and its reader.
    for (const times of [["09:00"], ["09:00", "12:00", "15:00"], []]) {
      assert.equal(
        validateCustomDistribution([{ date: "2026-08-18", count: 2, times }], 2, START, END, NOW),
        "time_count_mismatch",
        JSON.stringify(times)
      );
    }
  });

  it("rejects a time no clock can show", () => {
    for (const bad of ["24:00", "12:60", "9:00", "", "noon"]) {
      assert.equal(
        validateCustomDistribution(
          [{ date: "2026-08-18", count: 1, times: [bad] }],
          1,
          START,
          END,
          NOW
        ),
        "invalid_time",
        bad
      );
    }
  });

  it("rejects the same date and time twice", () => {
    // Two posts at one instant are indistinguishable on the calendar, and in this
    // mode there is no nudging one along — the user is asked to change it.
    assert.equal(
      validateCustomDistribution(
        [{ date: "2026-08-18", count: 2, times: ["09:00", "09:00"] }],
        2,
        START,
        END,
        NOW
      ),
      "duplicate_slot"
    );
  });

  it("catches two times that are one instant across the spring-forward hour", () => {
    // Sofia skips 03:00–03:59 on 2026-03-29, so a wall clock in that hour has no
    // instant of its own and resolves forward: 03:00 and 04:00 are the SAME
    // moment. Comparing the typed strings would let both through and write two
    // posts to one instant.
    assert.equal(
      validateCustomDistribution(
        [{ date: "2026-03-29", count: 2, times: ["03:00", "04:00"] }],
        2,
        "2026-03-01",
        "2026-03-31",
        new Date("2026-03-01T00:00:00.000Z")
      ),
      "duplicate_slot"
    );

    // An hour either side of the gap is two real, distinct instants.
    assert.equal(
      validateCustomDistribution(
        [{ date: "2026-03-29", count: 2, times: ["02:30", "04:30"] }],
        2,
        "2026-03-01",
        "2026-03-31",
        new Date("2026-03-01T00:00:00.000Z")
      ),
      null
    );
  });

  it("allows the same time on two different days", () => {
    // It is the date AND time together that must be unique; a channel posting at
    // 09:00 every day is the normal case, not a collision.
    assert.equal(
      validateCustomDistribution(
        [
          { date: "2026-08-18", count: 1, times: ["09:00"] },
          { date: "2026-08-19", count: 1, times: ["09:00"] },
        ],
        2,
        START,
        END,
        NOW
      ),
      null
    );
  });

  it("rejects a time that has already passed", () => {
    // 2026-08-17 12:00 Sofia is 09:00 UTC; an hour later, the slot is behind us.
    const afterwards = new Date("2026-08-17T10:00:00.000Z");
    assert.equal(
      validateCustomDistribution(
        [{ date: "2026-08-17", count: 1, times: ["12:00"] }],
        1,
        START,
        END,
        afterwards
      ),
      "time_in_past"
    );

    // Later the same day is still fine — it is the time that is checked, not the
    // day, so a same-day batch remains possible.
    assert.equal(
      validateCustomDistribution(
        [{ date: "2026-08-17", count: 1, times: ["18:00"] }],
        1,
        START,
        END,
        afterwards
      ),
      null
    );
  });

  it("measures the past in Sofia, not UTC", () => {
    // 09:30 UTC is 12:30 in Sofia. A 12:00 slot that day is therefore PAST, even
    // though 12:00 is still ahead on the UTC clock — reading it in UTC would let
    // through three hours of unpublishable posts every afternoon.
    const now = new Date("2026-08-17T09:30:00.000Z");
    assert.equal(
      validateCustomDistribution(
        [{ date: "2026-08-17", count: 1, times: ["12:00"] }],
        1,
        START,
        END,
        now
      ),
      "time_in_past"
    );
  });
});

describe("planCustomSlots — the user picks the days AND the times", () => {
  it("schedules exactly the times given, in the order they were given", () => {
    const slots = planCustomSlots([
      { date: "2026-08-17", count: 3, times: ["07:15", "13:40", "21:05"] },
      { date: "2026-08-19", count: 1, times: ["12:15"] },
    ]);

    assert.deepEqual(slots.map(stamp), [
      "2026-08-17T07:15",
      "2026-08-17T13:40",
      "2026-08-17T21:05",
      "2026-08-19T12:15",
    ]);
  });

  it("ignores the channel's posting windows entirely", () => {
    // The guarantee the whole mode rests on: whatever the channel is configured
    // for, a custom slot is the time the user typed. The planner does not even
    // accept windows any more, so this is checked by the times surviving on a day
    // the channel has no window for at all (Sunday on a Mon/Wed channel).
    assert.deepEqual(
      planCustomSlots([{ date: "2026-08-23", count: 2, times: ["06:00", "22:45"] }]).map(stamp),
      ["2026-08-23T06:00", "2026-08-23T22:45"]
    );
    // MON_WED exists for the even-spread tests; naming it here is what makes the
    // absence of a windows argument deliberate rather than forgotten.
    assert.equal(MON_WED.length, 2);
  });

  it("does not stack or nudge times, however close together they are", () => {
    // Even distribution pushes a colliding slot an hour on. Custom must not: the
    // user asked for 09:00 and 09:01, and moving either would answer a question
    // they did not ask. (Two IDENTICAL times are refused by validation instead.)
    assert.deepEqual(
      planCustomSlots([{ date: "2026-08-17", count: 3, times: ["09:00", "09:01", "23:59"] }]).map(
        stamp
      ),
      ["2026-08-17T09:00", "2026-08-17T09:01", "2026-08-17T23:59"]
    );
  });

  it("returns the slots in ascending order whatever order they arrive in", () => {
    const slots = planCustomSlots([
      { date: "2026-08-26", count: 1, times: ["09:00"] },
      { date: "2026-08-17", count: 2, times: ["18:30", "08:00"] },
      { date: "2026-08-19", count: 1, times: ["09:00"] },
    ]);

    assert.deepEqual(slots.map(stamp), [
      "2026-08-17T08:00",
      "2026-08-17T18:30",
      "2026-08-19T09:00",
      "2026-08-26T09:00",
    ]);
    for (let i = 1; i < slots.length; i++) {
      assert.ok(slots[i].getTime() > slots[i - 1].getTime());
    }
  });

  it("keeps a late slot on its own day rather than spilling over", () => {
    assert.deepEqual(
      planCustomSlots([
        { date: "2026-08-17", count: 2, times: ["23:00", "23:59"] },
        { date: "2026-08-18", count: 1, times: ["00:01"] },
      ]).map(stamp),
      ["2026-08-17T23:00", "2026-08-17T23:59", "2026-08-18T00:01"]
    );
  });

  it("skips what it cannot use rather than guessing a date or a time", () => {
    assert.deepEqual(planCustomSlots([]), []);
    assert.deepEqual(
      planCustomSlots([
        { date: "not-a-date", count: 1, times: ["09:00"] },
        { date: "2026-08-18", count: 2, times: ["10:00", "25:00"] },
        { date: "2026-08-19", count: 0, times: [] },
      ]).map(stamp),
      ["2026-08-18T10:00"]
    );
  });
});

describe("defaultTimesForDay — seeding the editor's inputs", () => {
  it("takes that weekday's configured windows in order", () => {
    assert.deepEqual(
      defaultTimesForDay("2026-08-17", 2, [
        { day: "MONDAY", start: "09:00", end: "10:00" },
        { day: "MONDAY", start: "18:30", end: "19:30" },
      ]),
      ["09:00", "18:30"]
    );
  });

  it("steps to the next slot past the last window when more posts are asked for", () => {
    assert.deepEqual(defaultTimesForDay("2026-08-17", 3, MON_WED), ["09:00", "09:30", "10:00"]);
  });

  it("seeds a slot even from a window configured between two", () => {
    // The editor offers slots and nothing else, so a seed of 09:15 would be a
    // starting value the user could not get back to. Forward, like every other
    // snap: 09:15 is published by the 09:30 sweep anyway.
    assert.deepEqual(
      defaultTimesForDay("2026-08-17", 2, [{ day: "MONDAY", start: "09:15", end: "11:00" }]),
      ["09:30", "10:00"]
    );
  });

  it("uses the channel's usual hour for a day it has no window for", () => {
    // Sunday on a Mon/Wed channel — the user chose the day, so it is seeded at
    // 09:00, the channel's own time, not an arbitrary default.
    assert.deepEqual(defaultTimesForDay("2026-08-23", 1, MON_WED), ["09:00"]);
  });

  it("falls back to 10:00 with nothing usable configured", () => {
    for (const windows of [undefined, [], { nonsense: true }]) {
      assert.deepEqual(defaultTimesForDay("2026-08-18", 2, windows), ["10:00", "10:30"]);
    }
  });

  it("uses the day's remaining slots up to the 23:30 clamp", () => {
    const times = defaultTimesForDay("2026-08-17", 4, [
      { day: "MONDAY", start: "22:00", end: "23:30" },
    ]);
    assert.deepEqual(times, ["22:00", "22:30", "23:00", "23:30"]);
    assert.equal(new Set(times).size, times.length);
  });

  it("repeats the last slot rather than moving a post onto the next day", () => {
    // A day genuinely runs out: four slots left, ten posts asked for. The editor
    // shows the collision and validateCustomDistribution refuses it — which is a
    // better answer than seeding a time the picker does not offer, or silently
    // scheduling for tomorrow.
    const times = defaultTimesForDay("2026-08-17", 6, [
      { day: "MONDAY", start: "22:00", end: "23:30" },
    ]);
    assert.deepEqual(times, ["22:00", "22:30", "23:00", "23:30", "23:30", "23:30"]);
  });

  it("gives every position a real time of day, up to a full batch", () => {
    for (const windows of [undefined, MON_WED, [{ day: "MONDAY", start: "23:30", end: "23:59" }]]) {
      const times = defaultTimesForDay("2026-08-17", MAX_BULK_POSTS, windows);
      assert.equal(times.length, MAX_BULK_POSTS);
      for (const time of times) assert.notEqual(parseTimeOfDay(time), null, time);
    }
  });

  it("seeds only times the editor's pickers offer", () => {
    // Every seed is a starting value in a slot picker, so every seed has to be a
    // slot — including the ones produced by the overflow and clamp branches.
    for (const windows of [
      undefined,
      MON_WED,
      [{ day: "MONDAY", start: "09:15", end: "11:00" }],
      [{ day: "MONDAY", start: "22:47", end: "23:59" }],
      [{ day: "MONDAY", start: "25:00", end: "26:00" }],
    ]) {
      for (const time of defaultTimesForDay("2026-08-17", MAX_BULK_POSTS, windows)) {
        assert.equal(isSlotAligned(time), true, `${time} is not a slot`);
      }
    }
  });

  it("returns nothing for a day or a count it cannot seed", () => {
    assert.deepEqual(defaultTimesForDay("not-a-date", 2), []);
    assert.deepEqual(defaultTimesForDay("2026-02-30", 2), []);
    assert.deepEqual(defaultTimesForDay("2026-08-17", 0), []);
    assert.deepEqual(defaultTimesForDay("2026-08-17", 1.5), []);
  });
});
