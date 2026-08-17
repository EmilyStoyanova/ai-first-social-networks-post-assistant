import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FEED_ITEM_CLASSIFICATION_FILTERS,
  awaitingClassification,
  classificationFilterWhere,
  classificationStateOf,
  parseClassificationFilter,
} from "./feed-item-classification-filter";

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

  it("treats `unclassified` as no verdict, whatever the status", () => {
    assert.deepEqual(classificationFilterWhere("unclassified"), { classification: null });
  });

  it("adds no predicate for `all`", () => {
    assert.deepEqual(classificationFilterWhere("all"), {});
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
});
