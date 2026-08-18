import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  addMonths,
  buildCalendarQuery,
  buildCalendarRange,
  calendarWindowInstants,
  endOfMonth,
  endOfWeek,
  isCalendarDay,
  isSameMonth,
  resolveCalendarAnchor,
  resolveCalendarView,
  shiftCalendarAnchor,
  startOfMonth,
  startOfWeek,
} from "./calendar-range";

// 2026-08-18 is a Tuesday; its week is Mon 17 → Sun 23 August.
const TUESDAY = "2026-08-18";

describe("isCalendarDay", () => {
  it("accepts a real day", () => {
    assert.equal(isCalendarDay(TUESDAY), true);
  });

  it("rejects a day that does not exist even though it parses", () => {
    // `new Date("2026-02-30")` rolls over into March rather than failing, so the
    // pattern alone would let a navigable-looking date through.
    assert.equal(isCalendarDay("2026-02-30"), false);
    assert.equal(isCalendarDay("2026-13-01"), false);
  });

  it("rejects anything that is not a bare day", () => {
    assert.equal(isCalendarDay("2026-8-18"), false);
    assert.equal(isCalendarDay("2026-08-18T09:00:00Z"), false);
    assert.equal(isCalendarDay(""), false);
  });
});

describe("day arithmetic", () => {
  it("adds and subtracts days across a month boundary", () => {
    assert.equal(addDays("2026-08-31", 1), "2026-09-01");
    assert.equal(addDays("2026-09-01", -1), "2026-08-31");
  });

  it("adds days across a year boundary", () => {
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  });

  it("adds days across a leap day", () => {
    assert.equal(addDays("2028-02-28", 1), "2028-02-29");
    assert.equal(addDays("2028-02-29", 1), "2028-03-01");
  });

  it("crosses a DST boundary without gaining or losing a day", () => {
    // Europe/Sofia springs forward on 2026-03-29 (03:00 → 04:00) and back on
    // 2026-10-25. The whole reason this arithmetic runs on day strings over UTC
    // is that a 23-hour day must still be exactly one day here.
    assert.equal(addDays("2026-03-28", 1), "2026-03-29");
    assert.equal(addDays("2026-03-29", 1), "2026-03-30");
    assert.equal(addDays("2026-10-24", 1), "2026-10-25");
    assert.equal(addDays("2026-10-25", 1), "2026-10-26");
  });

  it("clamps a month step to the target month's length", () => {
    // Naively adding a month to 31 January lands on 3 March, skipping February.
    assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
    assert.equal(addMonths("2026-03-31", -1), "2026-02-28");
    assert.equal(addMonths("2028-01-31", 1), "2028-02-29");
  });

  it("steps months across a year boundary", () => {
    assert.equal(addMonths("2026-12-15", 1), "2027-01-15");
    assert.equal(addMonths("2026-01-15", -1), "2025-12-15");
  });
});

describe("week and month bounds", () => {
  it("starts a week on Monday", () => {
    // Every day of one week resolves to the same Monday, including the Sunday —
    // the boundary an ISO week and a US week disagree about.
    for (const day of [
      "2026-08-17",
      "2026-08-18",
      "2026-08-19",
      "2026-08-20",
      "2026-08-21",
      "2026-08-22",
      "2026-08-23",
    ]) {
      assert.equal(startOfWeek(day), "2026-08-17", day);
      assert.equal(endOfWeek(day), "2026-08-23", day);
    }
  });

  it("puts the following Monday in the next week", () => {
    assert.equal(startOfWeek("2026-08-24"), "2026-08-24");
  });

  it("bounds a month", () => {
    assert.equal(startOfMonth(TUESDAY), "2026-08-01");
    assert.equal(endOfMonth(TUESDAY), "2026-08-31");
    assert.equal(endOfMonth("2026-02-10"), "2026-02-28");
    assert.equal(endOfMonth("2028-02-10"), "2028-02-29");
  });

  it("compares months", () => {
    assert.equal(isSameMonth("2026-08-01", "2026-08-31"), true);
    assert.equal(isSameMonth("2026-08-31", "2026-09-01"), false);
    assert.equal(isSameMonth("2025-08-18", "2026-08-18"), false);
  });
});

describe("resolveCalendarView", () => {
  it("accepts the two views", () => {
    assert.equal(resolveCalendarView("week"), "week");
    assert.equal(resolveCalendarView("month"), "month");
    assert.equal(resolveCalendarView(" MONTH "), "month");
  });

  it("falls back to week for anything else", () => {
    assert.equal(resolveCalendarView(undefined), "week");
    assert.equal(resolveCalendarView("day"), "week");
    assert.equal(resolveCalendarView(["month", "week"]), "month");
  });
});

describe("resolveCalendarAnchor", () => {
  it("takes the day the URL names", () => {
    assert.equal(resolveCalendarAnchor("2026-01-05", TUESDAY), "2026-01-05");
  });

  it("falls back to today when the URL says nothing usable", () => {
    assert.equal(resolveCalendarAnchor(undefined, TUESDAY), TUESDAY);
    assert.equal(resolveCalendarAnchor("yesterday", TUESDAY), TUESDAY);
    assert.equal(resolveCalendarAnchor("2026-02-30", TUESDAY), TUESDAY);
  });
});

describe("buildCalendarRange — week", () => {
  const range = buildCalendarRange("week", TUESDAY);

  it("covers Monday to Sunday", () => {
    assert.equal(range.periodStart, "2026-08-17");
    assert.equal(range.periodEnd, "2026-08-23");
  });

  it("draws exactly seven cells, in order, starting on the Monday", () => {
    assert.equal(range.days.length, 7);
    assert.equal(range.days[0], "2026-08-17");
    assert.equal(range.days[6], "2026-08-23");
    assert.deepEqual([...range.days].sort(), range.days);
  });

  it("contains the anchor", () => {
    assert.ok(range.days.includes(TUESDAY));
  });
});

describe("buildCalendarRange — month", () => {
  // August 2026 starts on a Saturday and ends on a Monday, so the grid pads at
  // both ends: 27 July → 6 September.
  const range = buildCalendarRange("month", TUESDAY);

  it("covers the calendar month", () => {
    assert.equal(range.periodStart, "2026-08-01");
    assert.equal(range.periodEnd, "2026-08-31");
  });

  it("pads out to whole Monday-to-Sunday weeks", () => {
    assert.equal(range.days[0], "2026-07-27");
    assert.equal(range.days[range.days.length - 1], "2026-09-06");
    assert.equal(range.days.length % 7, 0);
    assert.equal(range.days.length, 42);
  });

  it("marks the padding days as belonging to another month", () => {
    assert.equal(isSameMonth(range.days[0], range.anchor), false);
    assert.equal(isSameMonth("2026-08-01", range.anchor), true);
  });

  it("draws a 5-week grid for a month that fits in five weeks", () => {
    // February 2027 starts on a Monday and has 28 days — exactly four weeks, so
    // the grid needs no padding at all.
    const february = buildCalendarRange("month", "2027-02-10");
    assert.equal(february.days[0], "2027-02-01");
    assert.equal(february.days[february.days.length - 1], "2027-02-28");
    assert.equal(february.days.length, 28);
  });
});

describe("shiftCalendarAnchor", () => {
  it("moves a week by seven days", () => {
    assert.equal(shiftCalendarAnchor("week", TUESDAY, 1), "2026-08-25");
    assert.equal(shiftCalendarAnchor("week", TUESDAY, -1), "2026-08-11");
  });

  it("moves a month by one month, not by the grid's length", () => {
    // The August grid is 42 days wide; stepping by that would land in September
    // for a "Next" and skip a month entirely on the way back.
    assert.equal(shiftCalendarAnchor("month", TUESDAY, 1), "2026-09-18");
    assert.equal(shiftCalendarAnchor("month", TUESDAY, -1), "2026-07-18");
  });

  it("walks month by month without drifting, even from the 31st", () => {
    let anchor = "2026-01-31";
    const visited: string[] = [];
    for (let i = 0; i < 3; i++) {
      anchor = shiftCalendarAnchor("month", anchor, 1);
      visited.push(anchor.slice(0, 7));
    }
    assert.deepEqual(visited, ["2026-02", "2026-03", "2026-04"]);
  });
});

describe("calendarWindowInstants", () => {
  it("spans the visible days on the BUSINESS clock, half-open", () => {
    // Sofia is UTC+3 in August, so the week beginning Monday 17 August starts at
    // 21:00 UTC on Sunday the 16th — not at midnight UTC. Getting this wrong
    // pulls Sunday-evening posts into the wrong week.
    const { from, to } = calendarWindowInstants(buildCalendarRange("week", TUESDAY));

    assert.equal(from.toISOString(), "2026-08-16T21:00:00.000Z");
    assert.equal(to.toISOString(), "2026-08-23T21:00:00.000Z");
  });

  it("shifts with the offset across a DST change", () => {
    // The week of 26 October 2026 begins after Sofia falls back to UTC+2, so its
    // midnight is 22:00 UTC — an hour later than the week before it.
    const before = calendarWindowInstants(buildCalendarRange("week", "2026-10-21"));
    const after = calendarWindowInstants(buildCalendarRange("week", "2026-10-28"));

    assert.equal(before.from.toISOString(), "2026-10-18T21:00:00.000Z");
    assert.equal(after.from.toISOString(), "2026-10-25T22:00:00.000Z");
  });

  it("ends the window at the START of the day after the last cell", () => {
    // Half-open, so a post at exactly midnight belongs to one day only.
    const range = buildCalendarRange("week", TUESDAY);
    const { to } = calendarWindowInstants(range);
    const dayAfter = addDays(range.days[range.days.length - 1], 1);

    assert.equal(dayAfter, "2026-08-24");
    assert.equal(to.toISOString(), "2026-08-23T21:00:00.000Z");
  });
});

describe("buildCalendarQuery", () => {
  it("sets what it is given and preserves the rest", () => {
    const query = buildCalendarQuery("view=week&date=2026-08-18&status=drafts", {
      date: "2026-08-25",
    });
    const params = new URLSearchParams(query);

    assert.equal(params.get("date"), "2026-08-25");
    assert.equal(params.get("view"), "week");
    // Changing the week must never silently reset the status filter.
    assert.equal(params.get("status"), "drafts");
  });

  it("can change the view and the anchor together", () => {
    const params = new URLSearchParams(
      buildCalendarQuery("view=week&date=2026-08-18", { view: "month", date: "2026-08-18" })
    );

    assert.equal(params.get("view"), "month");
    assert.equal(params.get("date"), "2026-08-18");
  });
});
