import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as postingWindows from "./posting-windows";
import {
  hasPostingWindows,
  parsePostingWindows,
  postingDaySlots,
  postingDaysCoverTarget,
  resolveWindowStart,
  utcDayIndex,
  windowStartOn,
} from "./posting-windows";

const MON_WED = [
  { day: "MONDAY", start: "09:00", end: "17:00" },
  { day: "WEDNESDAY", start: "18:30", end: "20:00" },
];

/** Every shape that means "this channel has no schedule". */
const NOTHING_CONFIGURED = [
  null,
  undefined,
  [],
  "not json",
  {},
  [{ day: "FUNDAY", start: "09:00", end: "17:00" }],
  [{ day: "MONDAY", start: "9:00", end: "17:00" }],
];

describe("parsePostingWindows", () => {
  it("returns the configured windows", () => {
    assert.deepEqual(parsePostingWindows(MON_WED), MON_WED);
  });

  it("returns null for anything that is not a saved schedule", () => {
    for (const value of NOTHING_CONFIGURED) {
      assert.equal(parsePostingWindows(value), null, `${JSON.stringify(value)} is not a schedule`);
    }
  });
});

describe("hasPostingWindows — the automatic-generation gate", () => {
  it("is true only when an explicit schedule was saved", () => {
    assert.equal(hasPostingWindows(MON_WED), true);
    for (const value of NOTHING_CONFIGURED) {
      assert.equal(hasPostingWindows(value), false, `${JSON.stringify(value)}`);
    }
  });
});

describe("resolveWindowStart", () => {
  it("gives that weekday's own start time", () => {
    assert.deepEqual(resolveWindowStart(MON_WED, 0), { hour: 9, minute: 0 }, "Monday");
    assert.deepEqual(resolveWindowStart(MON_WED, 2), { hour: 18, minute: 30 }, "Wednesday");
  });

  it("falls back to the first configured window for a day with none", () => {
    // A fallback WITHIN a schedule the owner authored: a weekday-only channel
    // still keeps its usual hour on a Saturday. Not a substitute for a schedule.
    assert.deepEqual(resolveWindowStart(MON_WED, 5), { hour: 9, minute: 0 }, "Saturday");
  });

  it("returns null when nothing is configured — never an invented hour", () => {
    // The regression this whole module was changed for. A channel with no
    // windows used to be answered "10:00", and the weekly cron took that answer
    // and scheduled real posts with it.
    for (const value of NOTHING_CONFIGURED) {
      for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
        assert.equal(
          resolveWindowStart(value, dayIndex),
          null,
          `${JSON.stringify(value)} on day ${dayIndex}`
        );
      }
    }
  });

  it("exports no default posting hour at all", () => {
    // Belt and braces: the old `DEFAULT_POSTING_HOUR` export is what every
    // fallback in the codebase reached for, so its absence is the cheapest way
    // to keep a second one from quietly appearing.
    assert.equal("DEFAULT_POSTING_HOUR" in postingWindows, false);
  });
});

describe("windowStartOn", () => {
  it("reads a day's start time off already-parsed windows", () => {
    const parsed = parsePostingWindows(MON_WED);
    assert.ok(parsed);
    assert.deepEqual(windowStartOn(parsed, 0), { hour: 9, minute: 0 });
    assert.deepEqual(windowStartOn(parsed, 2), { hour: 18, minute: 30 });
  });
});

describe("postingDaySlots — the days an automatic post may land on", () => {
  it("gives each configured day its own start time, Monday first", () => {
    assert.deepEqual(postingDaySlots(parsePostingWindows(MON_WED) ?? []), [
      { dayIndex: 0, time: { hour: 9, minute: 0 } },
      { dayIndex: 2, time: { hour: 18, minute: 30 } },
    ]);
  });

  it("returns a day the schedule does not name — never", () => {
    // The bug this exists for: one Friday window used to authorise a post on
    // Monday, Tuesday, Wednesday and Saturday too.
    const friday = parsePostingWindows([{ day: "FRIDAY", start: "12:00", end: "17:00" }]) ?? [];
    assert.deepEqual(postingDaySlots(friday), [{ dayIndex: 4, time: { hour: 12, minute: 0 } }]);
  });

  it("collapses several windows on one weekday to that day's first", () => {
    const twice =
      parsePostingWindows([
        { day: "MONDAY", start: "08:00", end: "10:00" },
        { day: "MONDAY", start: "18:00", end: "20:00" },
      ]) ?? [];
    assert.deepEqual(postingDaySlots(twice), [{ dayIndex: 0, time: { hour: 8, minute: 0 } }]);
  });

  it("orders the days by the week, not by how they were typed", () => {
    const authored =
      parsePostingWindows([
        { day: "FRIDAY", start: "18:00", end: "19:00" },
        { day: "MONDAY", start: "09:00", end: "10:00" },
      ]) ?? [];
    assert.deepEqual(
      postingDaySlots(authored).map((slot) => slot.dayIndex),
      [0, 4]
    );
  });

  it("has no slots for a schedule that was never configured", () => {
    assert.deepEqual(postingDaySlots([]), []);
  });
});

describe("postingDaysCoverTarget — the configuration rule", () => {
  const day = (name: string, start: string) => ({ day: name, start, end: "23:00" });
  const FRIDAY_ONLY = [day("FRIDAY", "12:00")];
  const FOUR_DAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY"].map((d) => day(d, "09:00"));
  const FIVE_DAYS = [...FOUR_DAYS, day("FRIDAY", "09:00")];

  it("refuses 5 posts a week on a single posting day", () => {
    // The reported configuration, verbatim.
    assert.equal(postingDaysCoverTarget(5, FRIDAY_ONLY), false);
  });

  it("refuses 5 posts a week on four posting days", () => {
    // One short is still short — at most one automatic post per calendar day.
    assert.equal(postingDaysCoverTarget(5, FOUR_DAYS), false);
  });

  it("accepts 5 posts a week on five posting days", () => {
    assert.equal(postingDaysCoverTarget(5, FIVE_DAYS), true);
  });

  it("accepts one post a week on one posting day", () => {
    assert.equal(postingDaysCoverTarget(1, FRIDAY_ONLY), true);
  });

  it("counts two windows on the same weekday as one posting day", () => {
    const mondayTwice = [day("MONDAY", "08:00"), day("MONDAY", "18:00")];
    assert.equal(postingDaysCoverTarget(2, mondayTwice), false, "one day cannot carry two posts");
    assert.equal(postingDaysCoverTarget(1, mondayTwice), true);
  });

  it("accepts seven posts a week only with all seven days configured", () => {
    const sixDays = [...FIVE_DAYS, day("SATURDAY", "09:00")];
    assert.equal(postingDaysCoverTarget(7, sixDays), false);
    assert.equal(postingDaysCoverTarget(7, [...sixDays, day("SUNDAY", "09:00")]), true);
  });

  it("leaves a channel with no windows alone", () => {
    // Zero windows is the explicit "takes no part in automatic generation"
    // state, which every other part of the app already relies on. The rule is
    // about a schedule too narrow for its target, not about not having one.
    for (const nothing of [[], null, undefined]) {
      assert.equal(postingDaysCoverTarget(5, nothing), true, `${JSON.stringify(nothing)}`);
    }
  });

  it("leaves a channel with no weekly target alone", () => {
    assert.equal(postingDaysCoverTarget(0, FRIDAY_ONLY), true);
  });

  it("ignores the per-channel weekly ceiling it cannot exceed anyway", () => {
    // postsPerWeek is capped at MAX_POSTS_PER_CHANNEL_PER_WEEK (7) when the week
    // is filled, so a stored 100 asks for 7 days, not 100.
    const everyDay = [...FIVE_DAYS, day("SATURDAY", "09:00"), day("SUNDAY", "09:00")];
    assert.equal(postingDaysCoverTarget(100, everyDay), true);
  });
});

describe("the day rule does not leak into the automatic-generation gate", () => {
  it("still calls a one-day schedule a schedule", () => {
    // hasPostingWindows gates MANUAL bulk even-distribution as well. A narrow
    // schedule is a bad automatic configuration, not an absent one, and manual
    // generation must go on working exactly as before.
    assert.equal(hasPostingWindows([{ day: "FRIDAY", start: "12:00", end: "17:00" }]), true);
  });
});

describe("utcDayIndex", () => {
  it("indexes Monday-first", () => {
    // 2026-08-17 is a Monday.
    assert.equal(utcDayIndex(new Date("2026-08-17T00:00:00.000Z")), 0);
    assert.equal(utcDayIndex(new Date("2026-08-19T00:00:00.000Z")), 2, "Wednesday");
    assert.equal(utcDayIndex(new Date("2026-08-23T00:00:00.000Z")), 6, "Sunday");
  });
});

// ─── The invariant, guarded at the level of the source itself ─────────────────
//
// Every behavioural test above can be satisfied by a module that still holds a
// default hour it merely does not reach on the paths under test. This one reads
// the scheduling modules and asserts the hour is not in them AT ALL, because the
// failure mode being guarded against is a third fallback appearing quietly under
// a fourth name — which is exactly how the first two got there.

describe("no scheduling module holds an implicit default hour", () => {
  /** Every module that decides, or could decide, when a post is published. */
  const SCHEDULING_MODULES = [
    "lib/scheduling/posting-windows.ts",
    "lib/scheduling/bulk-schedule.ts",
    "lib/posts/bulk-form.ts",
    "lib/services/cron/generate-weekly-schedule.service.ts",
    "lib/services/ai/bulk-generate-posts.service.ts",
    "lib/services/ai/validate-bulk-request.service.ts",
  ];

  /**
   * The file's CODE — comment lines dropped.
   *
   * The comments in these modules discuss the removed default at length, and
   * deliberately so: the history is the reason the rule exists. What must not
   * come back is an executable one.
   */
  function codeOf(relativePath: string): string {
    const source = readFileSync(join(process.cwd(), relativePath), "utf8");
    return source
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        return !(
          trimmed.startsWith("//") ||
          trimmed.startsWith("*") ||
          trimmed.startsWith("/*") ||
          trimmed === ""
        );
      })
      .join("\n");
  }

  it("names no fallback-hour constant", () => {
    // The two that existed, plus the name the manual path used in between. A new
    // one under a new name would still trip the literal check below.
    for (const relativePath of SCHEDULING_MODULES) {
      const code = codeOf(relativePath);
      for (const banned of ["DEFAULT_POSTING_HOUR", "MANUAL_FALLBACK_TIME", "FALLBACK_TIME"]) {
        assert.equal(code.includes(banned), false, `${relativePath} still names ${banned}`);
      }
    }
  });

  it("hard-codes no time of day to fall back to", () => {
    // Any `"HH:mm"` literal in executable scheduling code is a time somebody
    // typed rather than a time a user configured. There are legitimately none:
    // every time in these modules comes out of the stored windows or out of the
    // request.
    for (const relativePath of SCHEDULING_MODULES) {
      const literals = codeOf(relativePath).match(/["'`]\d{2}:\d{2}["'`]/g) ?? [];
      assert.deepEqual(literals, [], `${relativePath} hard-codes ${literals.join(", ")}`);
    }
  });
});
