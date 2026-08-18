import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  calendarInstant,
  entriesWithinDays,
  groupEntriesByDay,
  placePost,
  placePosts,
} from "./calendar-entries";
import { buildCalendarRange } from "./calendar-range";

interface TestPost {
  id: string;
  scheduledFor: string | null;
  publishedAt: string | null;
}

function post(
  id: string,
  scheduledFor: string | null,
  publishedAt: string | null = null
): TestPost {
  return { id, scheduledFor, publishedAt };
}

describe("calendarInstant — which date a post is drawn at", () => {
  it("uses scheduledFor for a post that has not gone out", () => {
    const instant = calendarInstant(post("a", "2026-08-18T06:30:00.000Z"));
    assert.equal(instant?.toISOString(), "2026-08-18T06:30:00.000Z");
  });

  it("prefers publishedAt once the post has actually gone out", () => {
    // Approved for 09:00 Sofia, sent by the 09:20 sweep. The calendar shows when
    // it went, not when it was hoped for.
    const instant = calendarInstant(
      post("a", "2026-08-18T06:00:00.000Z", "2026-08-18T06:20:00.000Z")
    );
    assert.equal(instant?.toISOString(), "2026-08-18T06:20:00.000Z");
  });

  it("places a post published on demand, which has no scheduledFor at all", () => {
    // The card's "Approve & publish" path. Under a scheduledFor-first rule this
    // post would simply vanish from the calendar.
    const instant = calendarInstant(post("a", null, "2026-08-18T15:04:00.000Z"));
    assert.equal(instant?.toISOString(), "2026-08-18T15:04:00.000Z");
  });

  it("returns null for a draft with no date of any kind", () => {
    assert.equal(calendarInstant(post("a", null, null)), null);
  });

  it("returns null for an unparseable timestamp rather than an Invalid Date", () => {
    assert.equal(calendarInstant(post("a", "not a date")), null);
  });
});

describe("placePost — which DAY, on the business clock", () => {
  it("reports the business-zone day and wall clock, not UTC's", () => {
    // 21:30 UTC on 18 August is 00:30 on the 19th in Sofia (UTC+3). A calendar
    // built on UTC would draw this post on the wrong day.
    const entry = placePost(post("a", "2026-08-18T21:30:00.000Z"));

    assert.equal(entry?.day, "2026-08-19");
    assert.equal(entry?.time, "00:30");
  });

  it("keeps a late-evening post on its own day", () => {
    // 20:30 UTC is 23:30 Sofia — still the 18th.
    const entry = placePost(post("a", "2026-08-18T20:30:00.000Z"));

    assert.equal(entry?.day, "2026-08-18");
    assert.equal(entry?.time, "23:30");
  });

  it("puts a post at the very start of a business day on that day", () => {
    // 21:00 UTC on the 17th IS 00:00 on the 18th in Sofia — the exact instant
    // the windowed query uses as its lower bound.
    const entry = placePost(post("a", "2026-08-17T21:00:00.000Z"));

    assert.equal(entry?.day, "2026-08-18");
    assert.equal(entry?.time, "00:00");
  });

  it("reads the same instant differently either side of a DST change", () => {
    // 22:30 UTC is 01:30 the next day in summer (UTC+3) and 00:30 the next day
    // in winter (UTC+2) — both on the following day, but at different clocks.
    const summer = placePost(post("a", "2026-08-18T22:30:00.000Z"));
    const winter = placePost(post("b", "2026-11-18T22:30:00.000Z"));

    assert.equal(summer?.day, "2026-08-19");
    assert.equal(summer?.time, "01:30");
    assert.equal(winter?.day, "2026-11-19");
    assert.equal(winter?.time, "00:30");
  });

  it("pads the wall clock to HH:mm", () => {
    const entry = placePost(post("a", "2026-01-05T07:05:00.000Z"));
    assert.equal(entry?.time, "09:05");
  });

  it("returns null for an undated post", () => {
    assert.equal(placePost(post("a", null, null)), null);
  });
});

describe("placePosts", () => {
  it("drops undated posts and orders the rest by instant", () => {
    const placed = placePosts([
      post("late", "2026-08-18T15:00:00.000Z"),
      post("undated", null, null),
      post("early", "2026-08-18T06:00:00.000Z"),
      post("middle", "2026-08-18T09:00:00.000Z"),
    ]);

    assert.deepEqual(
      placed.map((entry) => entry.post.id),
      ["early", "middle", "late"]
    );
  });

  it("orders by the instant a post is DRAWN at, not by scheduledFor", () => {
    // The published post was scheduled first but went out last.
    const placed = placePosts([
      post("published", "2026-08-18T06:00:00.000Z", "2026-08-18T18:00:00.000Z"),
      post("scheduled", "2026-08-18T12:00:00.000Z"),
    ]);

    assert.deepEqual(
      placed.map((entry) => entry.post.id),
      ["scheduled", "published"]
    );
  });
});

describe("entriesWithinDays", () => {
  it("drops a post the windowed query returned but the grid does not draw", () => {
    // The read matches on scheduledFor OR publishedAt, so a post scheduled
    // inside the week and published before it comes back — and then resolves to
    // a day outside the grid. Only the resolved day can settle it.
    const week = buildCalendarRange("week", "2026-08-18");
    const entries = placePosts([
      post("inside", "2026-08-19T09:00:00.000Z"),
      post("publishedEarlier", "2026-08-19T09:00:00.000Z", "2026-08-10T09:00:00.000Z"),
    ]);

    assert.deepEqual(
      entriesWithinDays(entries, week.days).map((entry) => entry.post.id),
      ["inside"]
    );
  });

  it("keeps every post inside the period", () => {
    const week = buildCalendarRange("week", "2026-08-18");
    const entries = placePosts([
      // 21:00 UTC Sunday the 16th = Monday the 17th, 00:00 Sofia — the first cell.
      post("first", "2026-08-16T21:00:00.000Z"),
      // 20:59 UTC Sunday the 23rd = 23:59 Sofia — the last minute of the week.
      post("last", "2026-08-23T20:59:00.000Z"),
    ]);

    assert.deepEqual(
      entriesWithinDays(entries, week.days).map((entry) => entry.post.id),
      ["first", "last"]
    );
  });

  it("drops a post one minute outside the period on either side", () => {
    const week = buildCalendarRange("week", "2026-08-18");
    const entries = placePosts([
      // 23:59 Sofia on Sunday the 16th — the week before.
      post("before", "2026-08-16T20:59:00.000Z"),
      // 00:00 Sofia on Monday the 24th — the week after.
      post("after", "2026-08-23T21:00:00.000Z"),
    ]);

    assert.deepEqual(entriesWithinDays(entries, week.days), []);
  });
});

describe("groupEntriesByDay", () => {
  const week = buildCalendarRange("week", "2026-08-18");

  it("gives every visible day a bucket, empty ones included", () => {
    const byDay = groupEntriesByDay([], week.days);

    assert.equal(byDay.size, 7);
    for (const day of week.days) assert.deepEqual(byDay.get(day), []);
  });

  it("files each post under the day it was placed on", () => {
    const entries = placePosts([
      post("mon", "2026-08-17T06:00:00.000Z"),
      post("wed-late", "2026-08-19T15:00:00.000Z"),
      post("wed-early", "2026-08-19T06:00:00.000Z"),
    ]);
    const byDay = groupEntriesByDay(entries, week.days);

    assert.deepEqual(
      byDay.get("2026-08-17")?.map((e) => e.post.id),
      ["mon"]
    );
    // Chronological within the cell, inherited from placePosts.
    assert.deepEqual(
      byDay.get("2026-08-19")?.map((e) => e.post.id),
      ["wed-early", "wed-late"]
    );
    assert.deepEqual(byDay.get("2026-08-18"), []);
  });

  it("ignores an entry whose day is not on the grid", () => {
    const entries = placePosts([post("elsewhere", "2026-09-01T06:00:00.000Z")]);
    const byDay = groupEntriesByDay(entries, week.days);

    assert.equal([...byDay.values()].flat().length, 0);
  });
});
