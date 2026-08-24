import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as postingWindows from "./posting-windows";
import {
  hasPostingWindows,
  parsePostingWindows,
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
