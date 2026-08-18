import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FEED_ITEM_CLASSIFICATION_FILTERS,
  awaitingClassification,
  classificationBucketOf,
  classificationFilterWhere,
  classificationStateOf,
  isDiagnosticFilter,
  parseClassificationFilter,
  summarizeClassificationError,
  type FeedItemClassificationBucket,
} from "./feed-item-classification-filter";

// ─── A tiny interpreter for the `where` fragments ─────────────────────────────

/**
 * Enough of Prisma's matching semantics to decide whether a row would come back
 * for a given filter. Written out rather than asserted as a shape because the
 * property that matters is BEHAVIOURAL: which rows each pill actually returns.
 * A shape assertion happily passes on a well-formed clause that matches nothing.
 */
interface Row {
  classification: string | null;
  classificationStatus: string | null;
  usedInPost: boolean;
}

function matchesClause(value: unknown, clause: unknown): boolean {
  if (clause !== null && typeof clause === "object" && "in" in clause) {
    // Prisma's `in` compares values and NEVER matches NULL — the exact trap the
    // reclassification predicate fell into.
    const list = (clause as { in: unknown[] }).in;
    return value !== null && list.includes(value);
  }
  return value === clause;
}

function matchesWhere(row: Row, where: Record<string, unknown>): boolean {
  for (const [key, clause] of Object.entries(where)) {
    if (key === "OR") {
      const alternatives = clause as Record<string, unknown>[];
      if (!alternatives.some((alt) => matchesWhere(row, alt))) return false;
      continue;
    }
    if (!matchesClause(row[key as keyof Row], clause)) return false;
  }
  return true;
}

/** Every combination a stored row can be in. 4 verdicts × 6 statuses × 2. */
const ALL_ROWS: Row[] = [null, "HIGH", "MEDIUM", "REJECTED"].flatMap((classification) =>
  [null, "pending", "classifying", "completed", "skipped", "failed"].flatMap((status) =>
    [false, true].map((usedInPost) => ({
      classification,
      classificationStatus: status,
      usedInPost,
    }))
  )
);

const BUCKETS = FEED_ITEM_CLASSIFICATION_FILTERS.filter(
  (f): f is FeedItemClassificationBucket => f !== "all"
);

describe("parseClassificationFilter", () => {
  it("accepts every offered filter", () => {
    for (const filter of FEED_ITEM_CLASSIFICATION_FILTERS) {
      assert.equal(parseClassificationFilter(filter), filter);
    }
  });

  it("is case-insensitive and trims", () => {
    assert.equal(parseClassificationFilter("  HIGH "), "high");
  });

  it("falls back to `all` rather than erroring on junk", () => {
    // A stale bookmark should show the list, not a failure.
    for (const raw of [null, undefined, "", "nonsense", "REJECTED_MAYBE"]) {
      assert.equal(parseClassificationFilter(raw), "all");
    }
  });
});

describe("classificationFilterWhere", () => {
  it("filters HIGH, MEDIUM and REJECTED on the stored verdict", () => {
    assert.deepEqual(classificationFilterWhere("high"), { classification: "HIGH" });
    assert.deepEqual(classificationFilterWhere("medium"), { classification: "MEDIUM" });
    assert.deepEqual(classificationFilterWhere("rejected"), { classification: "REJECTED" });
  });

  it("adds no predicate for `all`", () => {
    assert.deepEqual(classificationFilterWhere("all"), {});
  });

  it("only ever selects rows with no verdict for the three no-verdict pills", () => {
    for (const filter of ["pending", "failed", "unclassified"] as const) {
      const where = classificationFilterWhere(filter);
      for (const row of ALL_ROWS.filter((r) => r.classification !== null)) {
        assert.equal(matchesWhere(row, where), false, `${filter} matched a ${row.classification}`);
      }
    }
  });

  it("splits every no-verdict row into exactly one pill", () => {
    // The property the counts depend on: the buckets partition the source, so
    // the pills add up to `all` and no article is counted twice or lost.
    for (const row of ALL_ROWS) {
      const matched = BUCKETS.filter((f) => matchesWhere(row, classificationFilterWhere(f)));
      assert.deepEqual(
        matched,
        [classificationBucketOf(row)],
        `${JSON.stringify(row)} matched ${JSON.stringify(matched)}`
      );
    }
  });

  it("never reports a consumed article as pending or failed", () => {
    // The whole point of the split. A used article is never reclassified, so the
    // status frozen on the day it was consumed is history, not a queue position.
    const usedPending: Row = {
      classification: null,
      classificationStatus: "pending",
      usedInPost: true,
    };
    const usedFailed: Row = {
      classification: null,
      classificationStatus: "failed",
      usedInPost: true,
    };

    for (const row of [usedPending, usedFailed]) {
      assert.equal(matchesWhere(row, classificationFilterWhere("pending")), false);
      assert.equal(matchesWhere(row, classificationFilterWhere("failed")), false);
      assert.equal(matchesWhere(row, classificationFilterWhere("unclassified")), true);
    }
  });

  it("counts a legacy row that never received a status as unclassified", () => {
    // Nullable columns added by a migration with no backfill. `in` cannot see
    // these, so the predicate has to name null as its own alternative.
    const legacy: Row = { classification: null, classificationStatus: null, usedInPost: false };
    assert.equal(matchesWhere(legacy, classificationFilterWhere("unclassified")), true);
    assert.equal(matchesWhere(legacy, classificationFilterWhere("pending")), false);
  });

  it("treats an in-flight `classifying` row as pending", () => {
    const row: Row = {
      classification: null,
      classificationStatus: "classifying",
      usedInPost: false,
    };
    assert.equal(matchesWhere(row, classificationFilterWhere("pending")), true);
  });

  it("returns a fragment the service can spread into a scoped where", () => {
    // The filter narrows; it must never carry a scope of its own, or a filtered
    // list could reach across sources.
    for (const filter of FEED_ITEM_CLASSIFICATION_FILTERS) {
      const where = classificationFilterWhere(filter);
      assert.equal("sourceId" in where, false);
      assert.equal("companyId" in where, false);
    }
  });
});

describe("classificationStateOf", () => {
  it("reads a stored verdict", () => {
    assert.equal(classificationStateOf({ classification: "HIGH" }), "high");
    assert.equal(classificationStateOf({ classification: "MEDIUM" }), "medium");
    assert.equal(classificationStateOf({ classification: "REJECTED" }), "rejected");
  });

  it("NEVER shows a failed classification as rejected", () => {
    // The single most important line in this module: "nobody could ask" and "the
    // company does not want this" are opposite claims.
    const state = classificationStateOf({ classification: null, classificationStatus: "failed" });
    assert.equal(state, "failed");
    assert.notEqual(state, "rejected");
  });

  it("shows a queued or in-flight item as pending", () => {
    assert.equal(classificationStateOf({ classificationStatus: "pending" }), "pending");
    assert.equal(classificationStateOf({ classificationStatus: "classifying" }), "pending");
  });

  it("shows a company with no topic configuration as skipped, not rejected", () => {
    const state = classificationStateOf({ classification: null, classificationStatus: "skipped" });
    assert.equal(state, "skipped");
  });

  it("shows a row the feature does not cover as unclassified", () => {
    assert.equal(classificationStateOf({}), "unclassified");
    assert.equal(classificationStateOf({ classificationStatus: null }), "unclassified");
  });

  it("NEVER shows a consumed article as pending", () => {
    // Its status froze on the day a post was written from it. Reclassification
    // excludes `usedInPost` rows on purpose, so "awaiting review" would be a
    // promise nothing in the system intends to keep.
    const state = classificationStateOf({
      classification: null,
      classificationStatus: "pending",
      usedInPost: true,
    });
    assert.equal(state, "used");
    assert.notEqual(state, "pending");
  });

  it("reads a consumed article's stale `failed` status as used, not failed", () => {
    assert.equal(
      classificationStateOf({ classificationStatus: "failed", usedInPost: true }),
      "used"
    );
  });

  it("keeps a consumed article's verdict — being used explains a MISSING one", () => {
    assert.equal(classificationStateOf({ classification: "HIGH", usedInPost: true }), "high");
    assert.equal(
      classificationStateOf({ classification: "REJECTED", usedInPost: true }),
      "rejected"
    );
  });
});

describe("classificationBucketOf", () => {
  it("keeps each priority in its own bucket", () => {
    assert.equal(classificationBucketOf({ classification: "HIGH" }), "high");
    assert.equal(classificationBucketOf({ classification: "MEDIUM" }), "medium");
    assert.equal(classificationBucketOf({ classification: "REJECTED" }), "rejected");
  });

  it("separates waiting from broken", () => {
    assert.equal(classificationBucketOf({ classificationStatus: "pending" }), "pending");
    assert.equal(classificationBucketOf({ classificationStatus: "classifying" }), "pending");
    assert.equal(classificationBucketOf({ classificationStatus: "failed" }), "failed");
  });

  it("collapses used, skipped and never-asked into one bucket", () => {
    // Three different reasons, one user-facing fact: no verdict, none coming.
    // The badge on the row says which; the pill only says how many.
    assert.equal(
      classificationBucketOf({ classificationStatus: "pending", usedInPost: true }),
      "unclassified"
    );
    assert.equal(classificationBucketOf({ classificationStatus: "skipped" }), "unclassified");
    assert.equal(classificationBucketOf({ classificationStatus: "completed" }), "unclassified");
    assert.equal(classificationBucketOf({}), "unclassified");
  });

  it("returns a bucket that is always an offered filter", () => {
    for (const row of ALL_ROWS) {
      assert.ok(
        (FEED_ITEM_CLASSIFICATION_FILTERS as readonly string[]).includes(
          classificationBucketOf(row)
        )
      );
    }
  });

  it("keeps a reopened row's previous verdict visible", () => {
    // Reclassification sets the status back to pending WITHOUT clearing the
    // verdict, so there is no window where a whole feed reads as unjudged.
    assert.equal(
      classificationStateOf({ classification: "HIGH", classificationStatus: "pending" }),
      "high"
    );
  });
});

describe("awaitingClassification", () => {
  it("is true while a verdict is still expected", () => {
    assert.equal(awaitingClassification({ classificationStatus: "pending" }), true);
    assert.equal(awaitingClassification({ classificationStatus: "failed" }), true);
  });

  it("is false once the question is settled one way or another", () => {
    assert.equal(awaitingClassification({ classification: "HIGH" }), false);
    assert.equal(awaitingClassification({ classificationStatus: "skipped" }), false);
    assert.equal(awaitingClassification({}), false);
  });

  it("is false for a consumed article whatever its status says", () => {
    // It used to be true forever here, which is what made the count misleading.
    assert.equal(
      awaitingClassification({ classificationStatus: "pending", usedInPost: true }),
      false
    );
    assert.equal(
      awaitingClassification({ classificationStatus: "failed", usedInPost: true }),
      false
    );
  });
});

describe("isDiagnosticFilter", () => {
  it("marks only the two malfunction pills", () => {
    assert.equal(isDiagnosticFilter("pending"), true);
    assert.equal(isDiagnosticFilter("failed"), true);
  });

  it("never hides a priority pill", () => {
    // These four are the shape of the feature; an empty one is informative
    // ("no top-priority articles yet") and must stay on screen.
    for (const filter of ["all", "high", "medium", "rejected", "unclassified"] as const) {
      assert.equal(isDiagnosticFilter(filter), false);
    }
  });
});

describe("summarizeClassificationError", () => {
  it("passes a short validator sentence through unchanged", () => {
    const msg = "HIGH was returned without citing a configured top priority topic.";
    assert.equal(summarizeClassificationError(msg), msg);
  });

  it("keeps only the first line of a multi-line provider dump", () => {
    assert.equal(
      summarizeClassificationError('429 Too Many Requests\n{"error":{"type":"rate_limit"}}'),
      "429 Too Many Requests"
    );
  });

  it("caps a long single line so a response body cannot land in the page", () => {
    const summary = summarizeClassificationError("x".repeat(400));
    assert.ok(summary);
    assert.ok(summary.length <= 161, `got ${summary.length}`);
    assert.ok(summary.endsWith("…"));
  });

  it("returns null for nothing to say", () => {
    assert.equal(summarizeClassificationError(null), null);
    assert.equal(summarizeClassificationError(undefined), null);
    assert.equal(summarizeClassificationError(""), null);
    assert.equal(summarizeClassificationError("   \n  "), null);
  });

  it("collapses whitespace so a wrapped message stays one line", () => {
    assert.equal(summarizeClassificationError("  timed   out  after 60s "), "timed out after 60s");
  });
});
