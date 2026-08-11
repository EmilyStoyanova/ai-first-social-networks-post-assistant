import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bulkOutcome,
  clampDayCount,
  customTotal,
  defaultBulkRange,
  enumerateDays,
  partialReasonKey,
  syncDayTimes,
  toCustomDistribution,
  toIsoDate,
  type BulkBatchResponse,
} from "./bulk-form";
import { MAX_BULK_POSTS, type CustomDistributionError } from "@/lib/scheduling/bulk-schedule";
import en from "@/i18n/messages/en.json";
import bg from "@/i18n/messages/bg.json";

function batch(overrides: Partial<BulkBatchResponse> = {}): BulkBatchResponse {
  return {
    batchId: "batch-1",
    requested: 5,
    generated: 5,
    failed: 0,
    postIds: [],
    posts: [],
    failures: [],
    notAttempted: 0,
    stoppedEarly: false,
    stopReason: null,
    ...overrides,
  };
}

describe("defaultBulkRange", () => {
  it("opens on tomorrow, not today", () => {
    // A window for today has very likely already passed by the time the form is
    // being filled in, and a post scheduled into the past reads as broken.
    const range = defaultBulkRange(new Date("2026-08-10T14:30:00.000Z"));
    assert.equal(range.startDate, "2026-08-11");
  });

  it("spans a fortnight inclusive", () => {
    const range = defaultBulkRange(new Date("2026-08-10T00:00:00.000Z"));
    assert.deepEqual(range, { startDate: "2026-08-11", endDate: "2026-08-24" });
    assert.equal(enumerateDays(range.startDate, range.endDate).length, 14);
  });

  it("rolls over a month and a year end without inventing a date", () => {
    assert.equal(defaultBulkRange(new Date("2026-08-31T12:00:00.000Z")).startDate, "2026-09-01");
    assert.deepEqual(defaultBulkRange(new Date("2026-12-31T12:00:00.000Z")), {
      startDate: "2027-01-01",
      endDate: "2027-01-14",
    });
  });

  it("counts tomorrow from the business day, not the UTC day", () => {
    // 22:00 UTC is already the next day in Sofia. Opening on "UTC tomorrow"
    // there would offer a start date that is today — the one thing this function
    // exists to avoid.
    assert.equal(defaultBulkRange(new Date("2026-08-10T22:00:00.000Z")).startDate, "2026-08-12");
    assert.equal(defaultBulkRange(new Date("2026-08-10T12:00:00.000Z")).startDate, "2026-08-11");
  });

  it("ignores the time of day within one business day", () => {
    // Both of these are the 10th in Sofia (03:00 and 23:59), so both open on
    // the 11th.
    const early = defaultBulkRange(new Date("2026-08-10T00:00:01.000Z"));
    const late = defaultBulkRange(new Date("2026-08-10T20:59:59.000Z"));
    assert.deepEqual(early, late);
  });
});

describe("enumerateDays", () => {
  it("lists every day in the range, both ends included", () => {
    assert.deepEqual(enumerateDays("2026-08-17", "2026-08-20"), [
      "2026-08-17",
      "2026-08-18",
      "2026-08-19",
      "2026-08-20",
    ]);
  });

  it("lists a single day for a single-day range", () => {
    assert.deepEqual(enumerateDays("2026-08-17", "2026-08-17"), ["2026-08-17"]);
  });

  it("returns nothing for a backwards or unparseable range", () => {
    assert.deepEqual(enumerateDays("2026-08-20", "2026-08-17"), []);
    assert.deepEqual(enumerateDays("", "2026-08-17"), []);
    assert.deepEqual(enumerateDays("2026-08-17", "nope"), []);
  });

  it("stops at the row limit rather than rendering a year of inputs", () => {
    const days = enumerateDays("2026-01-01", "2026-12-31");
    assert.equal(days.length, 62);
    assert.equal(days[0], "2026-01-01");
    assert.deepEqual(enumerateDays("2026-08-17", "2026-08-30", 3), [
      "2026-08-17",
      "2026-08-18",
      "2026-08-19",
    ]);
  });

  it("crosses a month boundary correctly", () => {
    assert.deepEqual(enumerateDays("2026-08-30", "2026-09-02"), [
      "2026-08-30",
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
    ]);
  });
});

describe("toCustomDistribution", () => {
  it("drops the untouched days, sorts what is left, and carries their times", () => {
    assert.deepEqual(
      toCustomDistribution(
        { "2026-08-20": 1, "2026-08-17": 2, "2026-08-19": 0 },
        {
          "2026-08-20": ["12:00"],
          "2026-08-17": ["09:00", "18:30"],
          "2026-08-19": ["10:00"],
        }
      ),
      [
        { date: "2026-08-17", count: 2, times: ["09:00", "18:30"] },
        { date: "2026-08-20", count: 1, times: ["12:00"] },
      ]
    );
  });

  it("is empty when nothing has been assigned", () => {
    assert.deepEqual(toCustomDistribution({}, {}), []);
    assert.deepEqual(toCustomDistribution({ "2026-08-17": 0 }, { "2026-08-17": ["09:00"] }), []);
  });

  it("cuts a day's times to its count and never pads them", () => {
    // Trailing times from a day that was lowered must not ride along as hidden
    // slots; a day whose times are short must reach validation short, so it is
    // refused rather than quietly completed with a time nobody chose.
    assert.deepEqual(
      toCustomDistribution({ "2026-08-17": 1 }, { "2026-08-17": ["09:00", "18:30"] }),
      [{ date: "2026-08-17", count: 1, times: ["09:00"] }]
    );
    assert.deepEqual(toCustomDistribution({ "2026-08-17": 2 }, { "2026-08-17": ["09:00"] }), [
      { date: "2026-08-17", count: 2, times: ["09:00"] },
    ]);
    assert.deepEqual(toCustomDistribution({ "2026-08-17": 1 }, {}), [
      { date: "2026-08-17", count: 1, times: [] },
    ]);
  });
});

describe("syncDayTimes", () => {
  /** Mon/Wed at 09:00, so a seeded Monday is predictable. */
  const MON_WED = [
    { day: "MONDAY", start: "09:00", end: "11:00" },
    { day: "WEDNESDAY", start: "09:00", end: "11:00" },
  ];

  it("seeds a new day from the channel's windows", () => {
    assert.deepEqual(syncDayTimes("2026-08-17", 3, undefined, MON_WED), [
      "09:00",
      "10:00",
      "11:00",
    ]);
  });

  it("keeps the times already chosen when the count goes up", () => {
    // The two times on screen must not be renumbered or re-seeded because a third
    // post was added; only the new position is filled in.
    assert.deepEqual(syncDayTimes("2026-08-17", 3, ["07:30", "16:45"], MON_WED), [
      "07:30",
      "16:45",
      "11:00",
    ]);
  });

  it("drops only the tail when the count goes down", () => {
    assert.deepEqual(syncDayTimes("2026-08-17", 1, ["07:30", "16:45"], MON_WED), ["07:30"]);
  });

  it("holds exactly `count` times, so the two can never disagree", () => {
    for (let count = 1; count <= MAX_BULK_POSTS; count++) {
      assert.equal(syncDayTimes("2026-08-17", count, ["07:30"], MON_WED).length, count);
    }
  });

  it("has no times for a day carrying no posts", () => {
    for (const count of [0, -1, 1.5, Number.NaN]) {
      assert.deepEqual(syncDayTimes("2026-08-17", count, ["07:30"], MON_WED), [], String(count));
    }
  });

  it("still shows a real time for a day it cannot seed", () => {
    // An unusable date seeds nothing, and an empty time input would read as a
    // bug; the API refuses the date either way.
    assert.deepEqual(syncDayTimes("not-a-date", 2, undefined, MON_WED), ["10:00", "10:00"]);
  });
});

describe("customTotal", () => {
  it("adds the assigned posts up", () => {
    assert.equal(customTotal({ "2026-08-17": 2, "2026-08-19": 3 }), 5);
    assert.equal(customTotal({}), 0);
  });

  it("treats an unusable entry as nothing rather than NaN", () => {
    assert.equal(customTotal({ "2026-08-17": Number.NaN, "2026-08-19": 2 }), 2);
  });
});

describe("clampDayCount", () => {
  it("reads a typed number", () => {
    assert.equal(clampDayCount("3"), 3);
  });

  it("treats empty, negative and non-numeric input as none", () => {
    for (const raw of ["", "0", "-2", "abc", " "]) {
      assert.equal(clampDayCount(raw), 0, raw);
    }
  });

  it("never returns more than one request could hold", () => {
    assert.equal(clampDayCount("999"), MAX_BULK_POSTS);
  });
});

describe("bulkOutcome", () => {
  it("is complete only when every requested post exists", () => {
    assert.equal(bulkOutcome(batch({ requested: 5, generated: 5 })), "complete");
    assert.equal(bulkOutcome(batch({ requested: 5, generated: 4 })), "partial");
    assert.equal(bulkOutcome(batch({ requested: 1, generated: 1 })), "complete");
  });
});

describe("partialReasonKey", () => {
  it("explains a time-budget stop on its own terms", () => {
    // Not a content problem: nothing needs fixing, the rest can just be asked
    // for again.
    assert.equal(
      partialReasonKey(batch({ generated: 2, stopReason: "time_budget", notAttempted: 3 })),
      "stoppedTimeBudget"
    );
  });

  it("uses the failing slot's own reason when a generation failed", () => {
    assert.equal(
      partialReasonKey(
        batch({
          generated: 2,
          stopReason: "generation_failed",
          failures: [
            {
              index: 3,
              scheduledFor: "2026-08-24T10:00:00.000Z",
              code: "NO_FEED_ITEMS_AVAILABLE",
              reason: "no_eligible_content",
              message: "…",
            },
          ],
        })
      ),
      "stopped_no_eligible_content"
    );
  });

  it("falls back rather than naming a reason it does not have", () => {
    assert.equal(
      partialReasonKey(batch({ generated: 2, stopReason: "generation_failed" })),
      "stoppedUnknown"
    );
  });

  it("only ever names a key both locales actually have", () => {
    // The key is BUILT from a reason string, so a new BulkFailureReason would
    // otherwise reach the summary as a next-intl crash rather than a message.
    // Every reason `classifyBulkFailure` can return is checked here.
    const reasons = [
      "no_eligible_content",
      "not_unique",
      "provider_error",
      "configuration",
      "channel_limit",
      "access",
    ];

    const keys = [
      partialReasonKey(batch({ generated: 1, stopReason: "time_budget" })),
      partialReasonKey(batch({ generated: 1, stopReason: "generation_failed" })),
      ...reasons.map((reason) =>
        partialReasonKey(
          batch({
            generated: 1,
            stopReason: "generation_failed",
            failures: [
              {
                index: 2,
                scheduledFor: "2026-08-24T10:00:00.000Z",
                code: "X",
                reason,
                message: "…",
              },
            ],
          })
        )
      ),
    ];

    for (const [locale, messages] of [
      ["en", en],
      ["bg", bg],
    ] as const) {
      const bulk = messages.posts.generate.bulk as Record<string, string>;
      for (const key of keys) {
        assert.equal(typeof bulk[key], "string", `${locale} is missing posts.generate.bulk.${key}`);
      }
    }
  });
});

describe("the distribution errors are all translated", () => {
  it("resolves a message for every CustomDistributionError in both locales", () => {
    // The form renders these by building the key from the code
    // (`distributionError_${code}`), so a code without a message is not a gap in
    // the copy — next-intl throws, and the error line becomes a crash exactly
    // when the user has something wrong to fix.
    //
    // Listed by hand because a type cannot be enumerated at runtime: adding a
    // code to CustomDistributionError means adding it here, which is the reminder.
    const codes: CustomDistributionError[] = [
      "empty",
      "invalid_date",
      "duplicate_date",
      "out_of_period",
      "invalid_count",
      "count_mismatch",
      "invalid_time",
      "time_count_mismatch",
      "duplicate_slot",
      "time_in_past",
    ];

    for (const [locale, messages] of [
      ["en", en],
      ["bg", bg],
    ] as const) {
      const bulk = messages.posts.generate.bulk as Record<string, string>;
      for (const code of codes) {
        const key = `distributionError_${code}`;
        assert.equal(typeof bulk[key], "string", `${locale} is missing posts.generate.bulk.${key}`);
      }
      // The per-post time input's accessible name, built the same way.
      assert.equal(typeof bulk.timeForPost, "string", `${locale} is missing timeForPost`);
    }
  });
});

describe("toIsoDate", () => {
  it("keeps the UTC day", () => {
    assert.equal(toIsoDate(new Date("2026-08-17T23:30:00.000Z")), "2026-08-17");
  });
});
