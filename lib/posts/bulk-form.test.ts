import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bulkOutcome,
  clampDayCount,
  customTotal,
  defaultBulkRange,
  enumerateDays,
  partialReasonKey,
  toCustomDistribution,
  toIsoDate,
  type BulkBatchResponse,
} from "./bulk-form";
import { MAX_BULK_POSTS } from "@/lib/scheduling/bulk-schedule";
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
  it("drops the untouched days and sorts what is left", () => {
    assert.deepEqual(toCustomDistribution({ "2026-08-20": 1, "2026-08-17": 2, "2026-08-19": 0 }), [
      { date: "2026-08-17", count: 2 },
      { date: "2026-08-20", count: 1 },
    ]);
  });

  it("is empty when nothing has been assigned", () => {
    assert.deepEqual(toCustomDistribution({}), []);
    assert.deepEqual(toCustomDistribution({ "2026-08-17": 0 }), []);
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

describe("toIsoDate", () => {
  it("keeps the UTC day", () => {
    assert.equal(toIsoDate(new Date("2026-08-17T23:30:00.000Z")), "2026-08-17");
  });
});
