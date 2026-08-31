import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_BULK_POSTS,
  MAX_BULK_RANGE_DAYS,
  configuredPostingDays,
  defaultTimesForDay,
  deriveEligibleSlots,
  formatTimeOfDay,
  inclusiveDayCount,
  isStartDateInPast,
  parseIsoDate,
  parseTimeOfDay,
  planCustomSlots,
  planEvenDistribution,
  validateCustomDistribution,
  type BulkPlanProblem,
  type BulkSlotPlan,
} from "./bulk-schedule";
import { appZoneInstant, toAppDateTimeLocal } from "./app-datetime-local";
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

/**
 * The clock a plan is measured against unless it names its own — a week before
 * START, so every period below is entirely in the future and the past-slot
 * filter has nothing to do.
 *
 * A default rather than a field on every plan literal because only the tests
 * that are ABOUT the clock should have to mention it; for the rest, "this period
 * has not started yet" is background, exactly as it is for a real user planning
 * next week.
 */
const NOW = new Date("2026-08-10T09:00:00.000Z");

/** A plan as the tests write one: `now` optional, defaulted to `NOW`. */
type TestPlan = Omit<BulkSlotPlan, "now"> & { now?: Date };

const withNow = (plan: TestPlan): BulkSlotPlan => ({ now: NOW, ...plan });

/** The eligible slots of a plan — `deriveEligibleSlots` with the default clock. */
function eligible(plan: TestPlan): Date[] {
  return deriveEligibleSlots(withNow(plan));
}

/**
 * The slots a plan plans, failing the test if it was refused instead.
 *
 * Every even-distribution expectation goes through here rather than through
 * `planEvenDistribution` directly, so a test that expected slots and got a
 * refusal says which refusal — the two are different answers now, not an array
 * and a shorter array.
 */
function plannedSlots(plan: TestPlan): Date[] {
  const result = planEvenDistribution(withNow(plan));
  assert.ok(result.ok, `expected a plan; refused as ${JSON.stringify(planProblem(plan))}`);
  return result.slots;
}

/** Why a plan was refused, failing the test if it was not. */
function planProblem(plan: TestPlan): BulkPlanProblem | null {
  const result = planEvenDistribution(withNow(plan));
  return result.ok ? null : result.problem;
}

/**
 * Mon/Wed, 09:00 to 10:00 — a realistic two-day-a-week channel.
 *
 * One hour wide, so it contributes exactly ONE eligible slot per matching day.
 * A window is a range that opens out into an hourly slot each, so the width is
 * now part of what a fixture says: the tests below that are about which DAYS a
 * channel publishes on keep a one-slot day so the day is all they are asserting,
 * and the tests about the width say so by using a wider one.
 */
const MON_WED = [
  { day: "MONDAY", start: "09:00", end: "10:00" },
  { day: "WEDNESDAY", start: "09:00", end: "10:00" },
];

/**
 * Every day at 10:00 — a channel whose owner said "post daily, mid-morning".
 *
 * Used by the tests below that are about the SPREAD rather than about which days
 * a channel posts on: one slot on every day of the period is what makes the
 * stratified-sampling arithmetic legible. It is a configured schedule like any
 * other, and it is spelled out here precisely because nothing in this module
 * produces one by itself any more — a channel with no windows plans nothing.
 */
const EVERY_DAY_10 = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
].map((day) => ({ day, start: "10:00", end: "11:00" }));

/** The reported configuration: one Friday afternoon, five hours wide. */
const FRIDAY_AFTERNOON = [{ day: "FRIDAY", start: "12:00", end: "17:00" }];

/** The same Friday, one hour wide — exactly one slot, so the slot is the assertion. */
const FRIDAY_NOON = [{ day: "FRIDAY", start: "12:00", end: "13:00" }];

/** 2026-08-21 is the first of the two Fridays inside START…END. */
const FRIDAY = "2026-08-21";

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

  it("puts an even-spread slot on the business clock too", () => {
    const slots = plannedSlots({
      startDate: START,
      endDate: START,
      count: 1,
      postingWindows: EVERY_DAY_10,
    });
    assert.deepEqual(slots.map(stamp), ["2026-08-17T10:00"]);
    assert.deepEqual(slots.map(whenUtc), ["2026-08-17T07:00:00.000Z"]);
  });

  it("converts an even-spread summer slot at the summer offset", () => {
    // The worked example: Friday 12:00 in Sofia, in August, is 09:00Z.
    const slots = plannedSlots({
      startDate: FRIDAY,
      endDate: FRIDAY,
      count: 1,
      postingWindows: FRIDAY_NOON,
    });
    assert.deepEqual(slots.map(stamp), ["2026-08-21T12:00"]);
    assert.deepEqual(slots.map(whenUtc), ["2026-08-21T09:00:00.000Z"]);
  });

  it("converts the same even-spread window at the winter offset", () => {
    // Same channel, same window, opposite side of the year: the wall clock does
    // not move, so the stored instant must. 2026-01-16 is a Friday.
    //
    // Its own clock, because this period is BEHIND the default one — a plan is
    // now measured against a "now", and a January period is only plannable from
    // a January standing point.
    const slots = plannedSlots({
      startDate: "2026-01-16",
      endDate: "2026-01-16",
      count: 1,
      postingWindows: FRIDAY_NOON,
      now: new Date("2026-01-09T09:00:00.000Z"),
    });
    assert.deepEqual(slots.map(stamp), ["2026-01-16T12:00"]);
    assert.deepEqual(slots.map(whenUtc), ["2026-01-16T10:00:00.000Z"]);
  });

  it("keeps every slot of a wide window on the business clock", () => {
    // Not just the first: the hourly walk inside a window happens in wall-clock
    // minutes and each one is converted on its own, so all five have to land at
    // the season's offset rather than the first one setting an offset the rest
    // inherit.
    const slots = plannedSlots({
      startDate: FRIDAY,
      endDate: FRIDAY,
      count: 5,
      postingWindows: FRIDAY_AFTERNOON,
    });
    assert.deepEqual(slots.map(whenUtc), [
      "2026-08-21T09:00:00.000Z",
      "2026-08-21T10:00:00.000Z",
      "2026-08-21T11:00:00.000Z",
      "2026-08-21T12:00:00.000Z",
      "2026-08-21T13:00:00.000Z",
    ]);
  });

  it("keeps a slot on the day it was planned for, not the UTC day before it", () => {
    // 00:30 Sofia is 21:30 UTC the previous day. The post belongs to the 17th,
    // which is the day the user chose and the day the card will show.
    const slots = planCustomSlots([{ date: "2026-08-17", count: 1, times: ["00:30"] }]);
    assert.deepEqual(slots.map(stamp), ["2026-08-17T00:30"]);
    assert.deepEqual(slots.map(whenUtc), ["2026-08-16T21:30:00.000Z"]);
  });

  it("seeds nothing from a window time that is not a real clock time", () => {
    // postingWindows is shape-checked, never range-checked. A "25:00" must not
    // become a seeded input the API then refuses as invalid_time — and it must
    // not be quietly swapped for some other hour either. It is the same answer
    // as "never configured": there is nothing here to seed from.
    assert.deepEqual(
      defaultTimesForDay("2026-08-17", 1, [{ day: "MONDAY", start: "25:00", end: "26:00" }]),
      []
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

describe("deriveEligibleSlots — the channel's own posting windows decide", () => {
  it("returns one slot per configured window inside the period", () => {
    const slots = eligible({
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

  it("gives a day with two windows the slots of both, in time order", () => {
    const slots = eligible({
      startDate: START,
      endDate: "2026-08-17",
      count: 1,
      // Deliberately out of order in the config; the output must not be. The
      // hourly walk starts at each window's own start, so a 07:15 window offers
      // 07:15 and 08:15 rather than snapping onto the hour.
      postingWindows: [
        { day: "MONDAY", start: "18:30", end: "20:00" },
        { day: "MONDAY", start: "07:15", end: "09:00" },
      ],
    });
    assert.deepEqual(slots.map(stamp), [
      "2026-08-17T07:15",
      "2026-08-17T08:15",
      "2026-08-17T18:30",
      "2026-08-17T19:30",
    ]);
  });

  it("offers each instant of overlapping windows once", () => {
    // 09:00–12:00 beside 11:00–14:00 is one run of slots from 09:00 to 13:00.
    // A doubled 11:00 would look twice as available as it is, and two posts
    // could be planned onto the same instant.
    const slots = eligible({
      startDate: START,
      endDate: "2026-08-17",
      count: 1,
      postingWindows: [
        { day: "MONDAY", start: "09:00", end: "12:00" },
        { day: "MONDAY", start: "11:00", end: "14:00" },
      ],
    });
    assert.deepEqual(slots.map(stamp), [
      "2026-08-17T09:00",
      "2026-08-17T10:00",
      "2026-08-17T11:00",
      "2026-08-17T12:00",
      "2026-08-17T13:00",
    ]);
  });

  it("does not count a duplicated window twice", () => {
    const slots = eligible({
      startDate: START,
      endDate: "2026-08-17",
      count: 1,
      postingWindows: [
        { day: "MONDAY", start: "09:00", end: "10:00" },
        { day: "MONDAY", start: "09:00", end: "10:00" },
      ],
    });
    assert.deepEqual(slots.map(stamp), ["2026-08-17T09:00"]);
  });

  it("reads a window whose end is unusable as its start alone", () => {
    // postingWindows is shape-checked, never range-checked, so a stored end can
    // be a "99:99" or sit before its own start. The start is still a time its
    // owner chose; what must not happen is an end being guessed and slots handed
    // out that nobody authorised.
    for (const end of ["99:99", "09:00", "08:00"]) {
      const slots = eligible({
        startDate: START,
        endDate: "2026-08-17",
        count: 1,
        postingWindows: [{ day: "MONDAY", start: "09:00", end }],
      });
      assert.deepEqual(slots.map(stamp), ["2026-08-17T09:00"], `end ${end}`);
    }
  });

  it("plans nothing for a channel with no posting windows", () => {
    // The core of the rule. There is no configured time of day, so there is no
    // time of day — an even spread cannot be planned and no hour is substituted
    // to make it look as though it could. The caller reports NO_POSTING_WINDOWS
    // and offers custom mode, where the user names the times.
    //
    // Every shape "nothing configured" arrives in gets the same answer: never
    // saved, saved empty, saved as something that does not parse, and saved with
    // a start no clock can show.
    for (const windows of [
      undefined,
      null,
      [],
      { nonsense: true },
      "windows",
      [{ day: "FUNDAY", start: "09:00", end: "11:00" }],
      [{ day: "MONDAY", start: "25:00", end: "26:00" }],
    ]) {
      assert.deepEqual(
        eligible({
          startDate: START,
          endDate: "2026-08-19",
          count: 1,
          postingWindows: windows,
        }),
        [],
        `for ${JSON.stringify(windows)}`
      );
    }
  });

  it("keeps the usable windows when only some of them are unusable", () => {
    // One bad entry is not a reason to treat the whole channel as unconfigured —
    // the owner did say when it publishes, just not legibly in one place.
    const slots = eligible({
      startDate: START,
      endDate: "2026-08-19",
      count: 1,
      postingWindows: [
        { day: "MONDAY", start: "25:00", end: "26:00" },
        { day: "TUESDAY", start: "08:45", end: "10:00" },
      ],
    });
    assert.deepEqual(slots.map(stamp), ["2026-08-18T08:45", "2026-08-18T09:45"]);
  });

  it("is empty when the range itself is unusable", () => {
    const plan = { count: 1, postingWindows: EVERY_DAY_10 };
    assert.deepEqual(eligible({ ...plan, startDate: END, endDate: START }), []);
    assert.deepEqual(eligible({ ...plan, startDate: "nope", endDate: END }), []);
  });
});

describe("planEvenDistribution — even spread, boundaries not pinned", () => {
  it("does not place posts on the start and end dates just to reach them", () => {
    const slots = plannedSlots({
      startDate: START,
      endDate: END,
      count: 5,
      postingWindows: EVERY_DAY_10,
    });

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
    const slots = plannedSlots({
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
    const slots = plannedSlots({
      startDate: START,
      endDate: END,
      // Every eligible slot the fortnight holds for this channel — the case
      // where an inventive planner would have the most to be inventive with.
      count: 4,
      postingWindows: MON_WED,
    });

    const configuredDays = new Set([1, 3]); // Monday, Wednesday (getUTCDay)
    for (const slot of slots) {
      assert.ok(configuredDays.has(slot.getUTCDay()), `${stamp(slot)} is not a Mon/Wed`);
    }
  });

  it("puts a single post inside the period, not on its first day", () => {
    const slots = plannedSlots({
      startDate: START,
      endDate: END,
      count: 1,
      postingWindows: EVERY_DAY_10,
    });
    // The centre of the one and only share — the middle of the period.
    assert.deepEqual(slots.map(stamp), ["2026-08-24T10:00"]);
  });

  it("uses every eligible slot when exactly as many are requested", () => {
    const available = eligible({
      startDate: START,
      endDate: END,
      count: 4,
      postingWindows: MON_WED,
    });
    const slots = plannedSlots({
      startDate: START,
      endDate: END,
      count: available.length,
      postingWindows: MON_WED,
    });
    assert.deepEqual(slots.map(stamp), available.map(stamp));
  });

  it("gives every post a slot of its own, ascending", () => {
    // With at least as many slots as posts the share centres are strictly
    // increasing, so this holds without any collision rule — which is why there
    // no longer is one to get wrong.
    for (const [windows, count] of [
      [EVERY_DAY_10, MAX_BULK_POSTS],
      [MON_WED, 4],
      [FRIDAY_AFTERNOON, 5],
    ] as const) {
      const slots = plannedSlots({
        startDate: START,
        endDate: END,
        count,
        postingWindows: windows,
      });
      assert.equal(slots.length, count);
      assert.equal(new Set(slots.map((s) => s.getTime())).size, count, "two posts share a slot");
      for (let i = 1; i < slots.length; i++) {
        assert.ok(slots[i].getTime() > slots[i - 1].getTime(), `slot ${i} is not after ${i - 1}`);
      }
    }
  });

  it("is deterministic — the same plan always yields the same slots", () => {
    const plan = { startDate: START, endDate: END, count: 4, postingWindows: MON_WED };
    assert.deepEqual(plannedSlots(plan).map(stamp), plannedSlots(plan).map(stamp));
  });

  it("fills a wide window an hour at a time, and stops at its end", () => {
    // The reported case. Five posts fit a five-hour Friday window exactly, and
    // the sixth would have to be 17:00 — see the refusal below.
    assert.deepEqual(
      plannedSlots({
        startDate: FRIDAY,
        endDate: FRIDAY,
        count: 5,
        postingWindows: FRIDAY_AFTERNOON,
      }).map(stamp),
      [
        "2026-08-21T12:00",
        "2026-08-21T13:00",
        "2026-08-21T14:00",
        "2026-08-21T15:00",
        "2026-08-21T16:00",
      ]
    );
  });

  describe("what it refuses, rather than approximating", () => {
    it("refuses a channel with no posting windows", () => {
      // No configured hour in, no schedule out. This once produced a full batch
      // dated 10:00 — a schedule indistinguishable from one somebody chose.
      for (const windows of [
        undefined,
        null,
        [],
        "nope",
        [{ day: "MONDAY", start: "25:00", end: "26:00" }],
      ]) {
        assert.deepEqual(
          planProblem({ startDate: START, endDate: END, count: 5, postingWindows: windows }),
          { code: "NO_POSTING_WINDOWS" },
          `for ${JSON.stringify(windows)}`
        );
      }
    });

    it("refuses a period holding none of the channel's posting days", () => {
      // A Monday-only channel asked for Tue–Thu. It used to publish on all three
      // at Monday's hour: one weekday's window authorising another's.
      assert.deepEqual(
        planProblem({
          startDate: "2026-08-18",
          endDate: "2026-08-20",
          count: 3,
          postingWindows: [{ day: "MONDAY", start: "09:00", end: "11:00" }],
        }),
        { code: "NO_POSTING_DAYS_IN_PERIOD", days: ["MONDAY"] }
      );
    });

    it("names every configured day when it refuses, Monday first", () => {
      // What the form shows the user, so they can see why their period is empty.
      assert.deepEqual(
        planProblem({
          startDate: "2026-08-18",
          endDate: "2026-08-18",
          count: 1,
          postingWindows: [
            { day: "FRIDAY", start: "12:00", end: "17:00" },
            { day: "MONDAY", start: "09:00", end: "11:00" },
          ],
        }),
        { code: "NO_POSTING_DAYS_IN_PERIOD", days: ["MONDAY", "FRIDAY"] }
      );
    });

    it("refuses more posts than the period has room for, and says how many it has", () => {
      // Six posts into a five-slot Friday. The sixth used to become 17:00 —
      // outside the window its owner configured.
      assert.deepEqual(
        planProblem({
          startDate: FRIDAY,
          endDate: FRIDAY,
          count: 6,
          postingWindows: FRIDAY_AFTERNOON,
        }),
        { code: "INSUFFICIENT_POSTING_SLOTS", requested: 6, available: 5 }
      );
    });

    it("never schedules past the end of a window, however many posts are asked for", () => {
      // The property behind the case above, over every count the API allows: a
      // planned slot is always one the channel's own window offers.
      const offered = new Set(
        eligible({
          startDate: START,
          endDate: END,
          count: 1,
          postingWindows: FRIDAY_AFTERNOON,
        }).map((slot) => slot.getTime())
      );

      for (let count = 1; count <= MAX_BULK_POSTS; count++) {
        const result = planEvenDistribution(
          withNow({
            startDate: START,
            endDate: END,
            count,
            postingWindows: FRIDAY_AFTERNOON,
          })
        );
        if (!result.ok) continue;
        for (const slot of result.slots) {
          assert.ok(offered.has(slot.getTime()), `${stamp(slot)} is outside the window`);
        }
      }
    });

    it("refuses an unusable request rather than guessing", () => {
      const windows = EVERY_DAY_10;
      for (const plan of [
        { startDate: START, endDate: END, count: 0, postingWindows: windows },
        { startDate: END, endDate: START, count: 3, postingWindows: windows },
        { startDate: "nope", endDate: END, count: 3, postingWindows: windows },
        { startDate: "2026-01-01", endDate: "2027-06-01", count: 3, postingWindows: windows },
      ]) {
        assert.notEqual(planProblem(plan), null, JSON.stringify(plan));
      }
    });
  });
});

describe("configuredPostingDays", () => {
  it("lists the distinct weekdays a channel publishes on, Monday first", () => {
    assert.deepEqual(configuredPostingDays(MON_WED), ["MONDAY", "WEDNESDAY"]);
    assert.deepEqual(configuredPostingDays(FRIDAY_AFTERNOON), ["FRIDAY"]);
  });

  it("is empty when there is no usable schedule", () => {
    for (const windows of [undefined, null, [], "nope"]) {
      assert.deepEqual(configuredPostingDays(windows), [], `for ${JSON.stringify(windows)}`);
    }
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
    return { date, count, times: defaultTimesForDay(date, count, EVERY_DAY_10) };
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

  it("seeds NOTHING when the channel has no usable window", () => {
    // The editor opens on empty time inputs and the user picks. Seeding a
    // plausible hour here would put a time on screen that nobody chose, and the
    // request that followed would be indistinguishable from a deliberate one.
    for (const windows of [
      undefined,
      null,
      [],
      { nonsense: true },
      "nope",
      [{ day: "MONDAY", start: "25:00", end: "26:00" }],
    ]) {
      assert.deepEqual(
        defaultTimesForDay("2026-08-18", 2, windows),
        [],
        `for ${JSON.stringify(windows)}`
      );
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
    for (const windows of [
      EVERY_DAY_10,
      MON_WED,
      [{ day: "MONDAY", start: "23:30", end: "23:59" }],
    ]) {
      const times = defaultTimesForDay("2026-08-17", MAX_BULK_POSTS, windows);
      assert.equal(times.length, MAX_BULK_POSTS);
      for (const time of times) assert.notEqual(parseTimeOfDay(time), null, time);
    }
  });

  it("seeds only times the editor's pickers offer", () => {
    // Every seed is a starting value in a slot picker, so every seed has to be a
    // slot — including the ones produced by the overflow and clamp branches.
    for (const windows of [
      EVERY_DAY_10,
      MON_WED,
      [{ day: "MONDAY", start: "09:15", end: "11:00" }],
      [{ day: "MONDAY", start: "22:47", end: "23:59" }],
    ]) {
      const times = defaultTimesForDay("2026-08-17", MAX_BULK_POSTS, windows);
      assert.equal(times.length, MAX_BULK_POSTS);
      for (const time of times) assert.equal(isSlotAligned(time), true, `${time} is not a slot`);
    }
  });

  it("returns nothing for a day or a count it cannot seed", () => {
    // Windows supplied throughout, so each of these fails on the day or the
    // count — not on having nothing to seed from, which is its own case above.
    assert.deepEqual(defaultTimesForDay("not-a-date", 2, EVERY_DAY_10), []);
    assert.deepEqual(defaultTimesForDay("2026-02-30", 2, EVERY_DAY_10), []);
    assert.deepEqual(defaultTimesForDay("2026-08-17", 0, EVERY_DAY_10), []);
    assert.deepEqual(defaultTimesForDay("2026-08-17", 1.5, EVERY_DAY_10), []);
  });
});

// ─── REGRESSION (written before the fix) ──────────────────────────────────────
//
// Two reported defects in Manual Bulk → Evenly distributed:
//
//   1. a weekday nobody configured could receive posts, whenever none of the
//      configured weekdays happened to fall inside the chosen period;
//   2. a window's END was never read, so surplus posts were stacked an hour at a
//      time straight out of the window the owner configured.
//
// Both are about the ELIGIBLE SET — which instants this channel may publish at —
// so both are asserted against it directly.

describe("a posting window authorises its own weekday and no other", () => {
  it("has no eligible slot when no configured weekday occurs in the period", () => {
    // A Monday-only channel, asked for Tuesday–Thursday. Monday's 09:00 is
    // Monday's; it does not become Tuesday's because Tuesday is what was asked
    // for. Nothing is eligible, and the caller refuses the request.
    assert.deepEqual(
      eligible({
        startDate: "2026-08-18",
        endDate: "2026-08-20",
        count: 1,
        postingWindows: [{ day: "MONDAY", start: "09:00", end: "11:00" }],
      }),
      []
    );
  });
});

describe("a posting window is a range, and every slot lies inside it", () => {
  it("offers one slot an hour from the start, up to but not including the end", () => {
    const slots = eligible({
      startDate: "2026-08-21",
      endDate: "2026-08-21",
      count: 1,
      postingWindows: [{ day: "FRIDAY", start: "12:00", end: "17:00" }],
    });
    assert.deepEqual(slots.map(stamp), [
      "2026-08-21T12:00",
      "2026-08-21T13:00",
      "2026-08-21T14:00",
      "2026-08-21T15:00",
      "2026-08-21T16:00",
    ]);
  });

  it("leaves the gap between two windows on one day a gap", () => {
    const slots = eligible({
      startDate: "2026-08-21",
      endDate: "2026-08-21",
      count: 1,
      postingWindows: [
        { day: "FRIDAY", start: "09:00", end: "11:00" },
        { day: "FRIDAY", start: "14:00", end: "17:00" },
      ],
    });
    assert.deepEqual(slots.map(stamp), [
      "2026-08-21T09:00",
      "2026-08-21T10:00",
      "2026-08-21T14:00",
      "2026-08-21T15:00",
      "2026-08-21T16:00",
    ]);
  });

  it("never schedules past the end of the window, however many posts are asked for", () => {
    // Five slots exist on that Friday; six were requested. Whatever the answer
    // is, 17:00 is not part of it — that is outside the window its owner wrote.
    const result = planEvenDistribution(
      withNow({
        startDate: FRIDAY,
        endDate: FRIDAY,
        count: 6,
        postingWindows: FRIDAY_AFTERNOON,
      })
    );
    for (const slot of result.ok ? result.slots : []) {
      assert.ok(stamp(slot) < "2026-08-21T17:00", `${stamp(slot)} is outside the window`);
    }
  });
});

// ─── REGRESSION (written before the fix) ──────────────────────────────────────
//
// A bulk period may start TODAY, and the channel's window for today has very
// likely already begun. Every slot the eligible set offers becomes a real
// `Post.scheduledFor`, so a slot that has already gone by is a post born past
// due — the publisher refuses to fire it and the user is left with a stranded
// draft. The set must therefore be the slots that are still ahead.

describe("an eligible slot is one that is still in the future", () => {
  /** Sofia wall clock → the instant it names. The tests read as a clock. */
  const sofia = (day: string, hour: number, minute = 0): Date => {
    const at = appZoneInstant(day, hour, minute);
    assert.ok(at, `${day} ${hour}:${minute}`);
    return at;
  };

  /** Friday 2026-08-21, 09:00–12:00 — three slots: 09:00, 10:00, 11:00. */
  const FRIDAY_MORNING = [{ day: "FRIDAY", start: "09:00", end: "12:00" }];

  const onFriday = (now: Date) =>
    eligible({
      startDate: FRIDAY,
      endDate: FRIDAY,
      count: 1,
      postingWindows: FRIDAY_MORNING,
      now,
    }).map(stamp);

  it("keeps every slot when the whole window is still ahead", () => {
    assert.deepEqual(onFriday(sofia(FRIDAY, 8, 30)), [
      "2026-08-21T09:00",
      "2026-08-21T10:00",
      "2026-08-21T11:00",
    ]);
  });

  it("drops the slots already gone when the window has begun", () => {
    assert.deepEqual(onFriday(sofia(FRIDAY, 10, 30)), ["2026-08-21T11:00"]);
  });

  it("treats a slot happening exactly now as gone, not as available", () => {
    // Strictly greater. A post scheduled for this very instant is a post whose
    // publish time has arrived before it has been written, let alone approved.
    assert.deepEqual(onFriday(sofia(FRIDAY, 10, 0)), ["2026-08-21T11:00"]);
  });

  it("keeps a slot one minute away", () => {
    assert.deepEqual(onFriday(sofia(FRIDAY, 10, 59)), ["2026-08-21T11:00"]);
  });

  it("has nothing left once the window has closed", () => {
    assert.deepEqual(onFriday(sofia(FRIDAY, 12, 30)), []);
  });

  it("filters a multi-day period one day at a time", () => {
    // Thu 20 → Sat 22, publishing 09:00–12:00 every day, at 10:30 on the Friday.
    // Yesterday goes entirely, today loses the slots behind the clock, and
    // tomorrow is untouched.
    const slots = eligible({
      startDate: "2026-08-20",
      endDate: "2026-08-22",
      count: 1,
      postingWindows: ["THURSDAY", "FRIDAY", "SATURDAY"].map((day) => ({
        day,
        start: "09:00",
        end: "12:00",
      })),
      now: sofia(FRIDAY, 10, 30),
    });

    assert.deepEqual(slots.map(stamp), [
      "2026-08-21T11:00",
      "2026-08-22T09:00",
      "2026-08-22T10:00",
      "2026-08-22T11:00",
    ]);
  });

  it("leaves a period entirely in the future alone", () => {
    assert.deepEqual(onFriday(sofia("2026-08-10", 9)), [
      "2026-08-21T09:00",
      "2026-08-21T10:00",
      "2026-08-21T11:00",
    ]);
  });

  it("compares instants, so the summer offset is honoured", () => {
    // 10:30 Sofia in August is 07:30Z, and the 11:00 slot is 08:00Z. Comparing
    // the wall clocks against a UTC now would drop it.
    const now = new Date("2026-08-21T07:30:00.000Z");
    assert.deepEqual(
      eligible({
        startDate: FRIDAY,
        endDate: FRIDAY,
        count: 1,
        postingWindows: FRIDAY_MORNING,
        now,
      }).map(whenUtc),
      ["2026-08-21T08:00:00.000Z"]
    );
  });

  it("compares instants, so the winter offset is honoured", () => {
    // Same wall clocks three months earlier: 10:30 Sofia is 08:30Z and the
    // 11:00 slot is 09:00Z. 2026-01-16 is a Friday.
    const now = new Date("2026-01-16T08:30:00.000Z");
    assert.deepEqual(
      eligible({
        startDate: "2026-01-16",
        endDate: "2026-01-16",
        count: 1,
        postingWindows: FRIDAY_MORNING,
        now,
      }).map(whenUtc),
      ["2026-01-16T09:00:00.000Z"]
    );
  });

  it("offers no instant twice across a spring-forward transition", () => {
    // Sofia skips 03:00 on 2026-03-29, so the 03:00 and 04:00 wall clocks of a
    // 01:00–06:00 window name the SAME instant. Two posts at one instant is what
    // the custom mode refuses outright as duplicate_slot; the even planner must
    // not manufacture the situation in the first place.
    const slots = eligible({
      startDate: "2026-03-29",
      endDate: "2026-03-29",
      count: 1,
      postingWindows: [{ day: "SUNDAY", start: "01:00", end: "06:00" }],
      now: new Date("2026-03-01T00:00:00.000Z"),
    });

    assert.equal(new Set(slots.map((s) => s.getTime())).size, slots.length, "an instant repeats");
    assert.deepEqual(slots.map(whenUtc), [
      "2026-03-28T23:00:00.000Z",
      "2026-03-29T00:00:00.000Z",
      "2026-03-29T01:00:00.000Z",
      "2026-03-29T02:00:00.000Z",
    ]);
  });
});

describe("what a past slot does to the refusals", () => {
  const FRIDAY_LONG = [{ day: "FRIDAY", start: "09:00", end: "14:00" }];

  it("counts only the FUTURE slots as available", () => {
    // Five slots on that Friday, three already gone at 11:30, three requested.
    const problem = planProblem({
      startDate: FRIDAY,
      endDate: FRIDAY,
      count: 3,
      postingWindows: FRIDAY_LONG,
      now: appZoneInstant(FRIDAY, 11, 30)!,
    });

    assert.deepEqual(problem, {
      code: "INSUFFICIENT_POSTING_SLOTS",
      requested: 3,
      available: 2,
    });
  });

  it("has its own answer when every slot has gone by", () => {
    // Distinct from "no posting day in this period": the day IS here, its
    // window simply has nothing left in it.
    assert.deepEqual(
      planProblem({
        startDate: FRIDAY,
        endDate: FRIDAY,
        count: 1,
        postingWindows: FRIDAY_LONG,
        now: appZoneInstant(FRIDAY, 20, 0)!,
      }),
      { code: "NO_FUTURE_POSTING_SLOTS" }
    );
  });

  it("still says NO_POSTING_DAYS_IN_PERIOD when the day never occurs", () => {
    // The two must stay tellable apart — one is fixed by widening the period,
    // the other by choosing a later one.
    assert.deepEqual(
      planProblem({
        startDate: "2026-08-18",
        endDate: "2026-08-20",
        count: 1,
        postingWindows: FRIDAY_LONG,
        now: new Date("2026-08-10T09:00:00.000Z"),
      }),
      { code: "NO_POSTING_DAYS_IN_PERIOD", days: ["FRIDAY"] }
    );
  });

  it("plans from the future slots when enough of them remain", () => {
    assert.deepEqual(
      plannedSlots({
        startDate: FRIDAY,
        endDate: FRIDAY,
        count: 2,
        postingWindows: FRIDAY_LONG,
        now: appZoneInstant(FRIDAY, 11, 30)!,
      }).map(stamp),
      ["2026-08-21T12:00", "2026-08-21T13:00"]
    );
  });
});
