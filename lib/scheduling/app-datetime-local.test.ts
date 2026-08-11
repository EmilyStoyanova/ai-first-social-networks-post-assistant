import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  appZoneClock,
  appZoneInstant,
  appZoneToday,
  fromAppDateTimeLocal,
  toAppDateTimeLocal,
} from "./app-datetime-local";

// Europe/Sofia is UTC+2 in winter and UTC+3 in summer (DST runs from the last
// Sunday in March to the last Sunday in October).

describe("toAppDateTimeLocal", () => {
  it("shows a summer instant in the business zone, not UTC", () => {
    assert.equal(toAppDateTimeLocal("2026-08-20T09:00:00.000Z"), "2026-08-20T12:00");
  });

  it("shows a winter instant with the winter offset", () => {
    assert.equal(toAppDateTimeLocal("2026-01-20T09:00:00.000Z"), "2026-01-20T11:00");
  });

  it("rolls the date over when the zone offset pushes past midnight", () => {
    // 22:30 UTC is already the next day in Sofia — an input showing the UTC date
    // here would be showing the user a day they did not pick.
    assert.equal(toAppDateTimeLocal("2026-08-20T22:30:00.000Z"), "2026-08-21T01:30");
  });

  it("accepts a Date as readily as an ISO string", () => {
    assert.equal(
      toAppDateTimeLocal(new Date("2026-08-20T09:00:00.000Z")),
      toAppDateTimeLocal("2026-08-20T09:00:00.000Z")
    );
  });

  it("returns an empty value for something unparseable", () => {
    assert.equal(toAppDateTimeLocal("not a date"), "");
    assert.equal(toAppDateTimeLocal(new Date("nope")), "");
  });
});

describe("fromAppDateTimeLocal", () => {
  it("reads a typed time as business-zone wall clock", () => {
    // The whole point: 18:30 typed by a viewer anywhere means 18:30 in Sofia,
    // matching the text rendered beside the input.
    assert.equal(fromAppDateTimeLocal("2026-08-20T18:30"), "2026-08-20T15:30:00.000Z");
  });

  it("uses the winter offset for a winter date", () => {
    assert.equal(fromAppDateTimeLocal("2026-01-20T18:30"), "2026-01-20T16:30:00.000Z");
  });

  it("accepts a value carrying seconds", () => {
    // Some browsers include them when the input has a step.
    assert.equal(fromAppDateTimeLocal("2026-08-20T18:30:00"), "2026-08-20T15:30:00.000Z");
  });

  it("rejects anything that is not a datetime-local value", () => {
    for (const bad of ["", "2026-08-20", "20/08/2026 18:30", "2026-08-20T18", "nope"]) {
      assert.equal(fromAppDateTimeLocal(bad), null, bad);
    }
  });

  it("rejects a value with real digits but no real date", () => {
    assert.equal(fromAppDateTimeLocal("2026-13-45T99:99"), null);
  });
});

describe("the two directions agree", () => {
  it("round-trips an instant through the input and back", () => {
    for (const instant of [
      "2026-08-20T09:00:00.000Z",
      "2026-01-20T09:00:00.000Z",
      "2026-08-20T22:30:00.000Z",
      "2026-12-31T23:00:00.000Z",
    ]) {
      assert.equal(fromAppDateTimeLocal(toAppDateTimeLocal(instant)), instant, instant);
    }
  });

  it("round-trips across both sides of a DST change", () => {
    // 29 March 2026 is the spring-forward Sunday; 25 October the fall-back one.
    for (const instant of [
      "2026-03-28T12:00:00.000Z",
      "2026-03-30T12:00:00.000Z",
      "2026-10-24T12:00:00.000Z",
      "2026-10-26T12:00:00.000Z",
    ]) {
      assert.equal(fromAppDateTimeLocal(toAppDateTimeLocal(instant)), instant, instant);
    }
  });

  it("resolves a wall clock inside the skipped hour forward instead of failing", () => {
    // 03:30 on the spring-forward morning never happens in Sofia. A reschedule
    // form must still produce a real instant rather than null, and it must land
    // after the transition, never before it.
    const resolved = fromAppDateTimeLocal("2026-03-29T03:30");
    assert.notEqual(resolved, null);
    assert.ok(
      new Date(resolved as string).getTime() > Date.parse("2026-03-29T01:00:00.000Z"),
      `expected an instant after the transition, got ${resolved}`
    );
  });
});

describe("appZoneInstant — a calendar day plus a configured time", () => {
  it("reads the time as business-zone wall clock, summer and winter", () => {
    // The same 18:30 is a different instant in August and in January; what stays
    // fixed is what the user sees.
    assert.equal(appZoneInstant("2026-08-17", 18, 30)?.toISOString(), "2026-08-17T15:30:00.000Z");
    assert.equal(appZoneInstant("2026-01-19", 18, 30)?.toISOString(), "2026-01-19T16:30:00.000Z");
  });

  it("keeps an early time on the day it was asked for", () => {
    // 00:30 Sofia is the previous evening in UTC. The instant is what moves; the
    // day the post belongs to does not.
    const at = appZoneInstant("2026-08-17", 0, 30);
    assert.equal(at?.toISOString(), "2026-08-16T21:30:00.000Z");
    assert.equal(toAppDateTimeLocal(at as Date), "2026-08-17T00:30");
  });

  it("refuses a time that is not on the clock", () => {
    // `postingWindows` is shape-checked, never range-checked, so "25:00" reaches
    // here. Rolling it into the next day would move a post off its own date.
    for (const [h, m] of [
      [24, 0],
      [25, 0],
      [-1, 0],
      [10, 60],
      [10, -1],
      [10.5, 0],
    ]) {
      assert.equal(appZoneInstant("2026-08-17", h, m), null, `${h}:${m}`);
    }
  });

  it("refuses a day that is not a day", () => {
    assert.equal(appZoneInstant("2026-02-30", 10, 0), null);
    assert.equal(appZoneInstant("17/08/2026", 10, 0), null);
    assert.equal(appZoneInstant("", 10, 0), null);
  });

  it("round-trips with appZoneClock", () => {
    const at = appZoneInstant("2026-08-17", 18, 30) as Date;
    assert.deepEqual(appZoneClock(at), { day: "2026-08-17", hour: 18, minute: 30 });
  });
});

describe("appZoneClock", () => {
  it("reads an instant on the business clock", () => {
    assert.deepEqual(appZoneClock(new Date("2026-08-20T09:00:00.000Z")), {
      day: "2026-08-20",
      hour: 12,
      minute: 0,
    });
  });

  it("reports the business day, which may not be the UTC one", () => {
    assert.deepEqual(appZoneClock(new Date("2026-08-20T22:30:00.000Z")), {
      day: "2026-08-21",
      hour: 1,
      minute: 30,
    });
  });

  it("returns null rather than a nonsense clock", () => {
    assert.equal(appZoneClock(new Date(Number.NaN)), null);
  });
});

describe("appZoneToday", () => {
  it("is the calendar day in the business zone", () => {
    assert.equal(appZoneToday(new Date("2026-08-20T09:00:00.000Z")), "2026-08-20");
  });

  it("has already turned over while UTC has not", () => {
    // The three hours a day when "today" differs — and the whole reason a form
    // offering publishing dates cannot ask UTC what day it is.
    assert.equal(appZoneToday(new Date("2026-08-20T21:30:00.000Z")), "2026-08-21");
    assert.equal(appZoneToday(new Date("2026-08-20T20:30:00.000Z")), "2026-08-20");
  });

  it("turns over an hour later in winter", () => {
    assert.equal(appZoneToday(new Date("2026-01-20T22:30:00.000Z")), "2026-01-21");
    assert.equal(appZoneToday(new Date("2026-01-20T21:30:00.000Z")), "2026-01-20");
  });
});
