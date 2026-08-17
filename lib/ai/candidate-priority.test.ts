import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CANDIDATE_TIERS,
  PRIORITY_TIER_FILTERS,
  countOffered,
  describePrioritySelection,
  emptyPriorityDiagnostic,
  orderByPriority,
  priorityTierWheres,
  tierOf,
} from "./candidate-priority";

// The eligibility filter an automatic run starts from — every pre-existing rule.
const BASE = {
  companyId: "co-1",
  enabled: true,
  usedInPost: false,
  source: { enabled: true },
};

describe("tierOf", () => {
  it("maps each stored verdict to its tier", () => {
    assert.equal(tierOf("HIGH"), "high");
    assert.equal(tierOf("MEDIUM"), "medium");
    assert.equal(tierOf("REJECTED"), "rejected");
  });

  it("treats every kind of missing verdict as unclassified, never as rejected", () => {
    // null covers an unconfigured company, a queued item and a FAILED
    // classification. Reading any of them as rejected would discard content
    // because a model was briefly unavailable.
    assert.equal(tierOf(null), "unclassified");
    assert.equal(tierOf(undefined), "unclassified");
    assert.equal(tierOf(""), "unclassified");
  });
});

describe("PRIORITY_TIER_FILTERS", () => {
  it("queries HIGH, then MEDIUM, then unclassified — in that order", () => {
    assert.deepEqual(
      PRIORITY_TIER_FILTERS.map((t) => t.tier),
      ["high", "medium", "unclassified"]
    );
    assert.deepEqual(
      PRIORITY_TIER_FILTERS.map((t) => t.where.classification),
      ["HIGH", "MEDIUM", null]
    );
  });

  it("never queries REJECTED — the exclusion is the absence, not a NOT filter", () => {
    assert.equal(
      PRIORITY_TIER_FILTERS.some((t) => t.where.classification === "REJECTED"),
      false
    );
  });

  it("ranks the tiers in the same order the merge consumes them", () => {
    assert.deepEqual(
      [...CANDIDATE_TIERS],
      PRIORITY_TIER_FILTERS.map((t) => t.tier)
    );
  });
});

describe("priorityTierWheres", () => {
  it("keeps every eligibility rule on all three tiers", () => {
    // The claim this pins: priority ORDERS, it never grants eligibility. A
    // disabled or already-consumed HIGH article must be absent from the HIGH
    // query rather than blocking the MEDIUM one.
    for (const { where } of priorityTierWheres(BASE)) {
      assert.equal(where.enabled, true, "manual disable must survive into every tier");
      assert.equal(where.usedInPost, false, "one-post-per-article must survive into every tier");
      assert.deepEqual(where.source, { enabled: true });
      assert.equal(where.companyId, "co-1");
    }
  });

  it("adds exactly one key per tier — the classification", () => {
    for (const { where } of priorityTierWheres(BASE)) {
      assert.deepEqual(Object.keys(where).sort(), [...Object.keys(BASE), "classification"].sort());
    }
  });

  it("cannot be widened by a tier — the base is spread first", () => {
    // A tier that tried to re-open `usedInPost` would be overridden by nothing,
    // so this asserts the composition order rather than a value.
    const scoped = priorityTierWheres({ ...BASE, sourceId: "src-1" });
    for (const { where } of scoped) assert.equal(where.sourceId, "src-1");
  });

  it("does not mutate the base filter", () => {
    const base = { ...BASE };
    priorityTierWheres(base);
    assert.deepEqual(base, BASE);
  });
});

describe("orderByPriority", () => {
  const item = (id: string, classification: string | null) => ({ id, classification });

  it("puts HIGH before MEDIUM before unclassified", () => {
    const ordered = orderByPriority([item("u", null), item("m", "MEDIUM"), item("h", "HIGH")]);
    assert.deepEqual(
      ordered.map((i) => i.id),
      ["h", "m", "u"]
    );
  });

  it("preserves the query's recency order within a tier", () => {
    // Stability is what makes this purely additive: the pre-existing
    // `publishedAt desc, createdAt desc` still decides ties.
    const ordered = orderByPriority([item("h1", "HIGH"), item("h2", "HIGH"), item("h3", "HIGH")]);
    assert.deepEqual(
      ordered.map((i) => i.id),
      ["h1", "h2", "h3"]
    );
  });

  it("leaves an unconfigured company's window exactly as it was", () => {
    // Every row null — the backwards-compatibility case. The order out must
    // equal the order in, or this feature changed behaviour for companies that
    // never opted into it.
    const window = [item("a", null), item("b", null), item("c", null)];
    assert.deepEqual(orderByPriority(window), window);
  });

  it("sorts a stray REJECTED last rather than silently promoting it", () => {
    const ordered = orderByPriority([item("r", "REJECTED"), item("m", "MEDIUM")]);
    assert.deepEqual(
      ordered.map((i) => i.id),
      ["m", "r"]
    );
  });

  it("does not mutate its input", () => {
    const window = [item("m", "MEDIUM"), item("h", "HIGH")];
    orderByPriority(window);
    assert.deepEqual(
      window.map((i) => i.id),
      ["m", "h"]
    );
  });
});

describe("countOffered", () => {
  it("counts the window by tier", () => {
    const counts = countOffered([
      { classification: "HIGH" },
      { classification: "HIGH" },
      { classification: "MEDIUM" },
      { classification: null },
    ]);
    assert.deepEqual(counts, { high: 2, medium: 1, unclassified: 1 });
  });

  it("never files a REJECTED row under a tier it is not in", () => {
    const counts = countOffered([{ classification: "REJECTED" }]);
    assert.deepEqual(counts, { high: 0, medium: 0, unclassified: 0 });
  });
});

describe("describePrioritySelection", () => {
  it("explains a MEDIUM selection when HIGH articles exist but were withheld", () => {
    const diagnostic = emptyPriorityDiagnostic();
    diagnostic.offered = { high: 0, medium: 2, unclassified: 0 };
    diagnostic.withheldHigh = { used: 4, disabled: 1, sourceDisabled: 0 };
    diagnostic.selected = "medium";

    const line = describePrioritySelection(diagnostic);
    assert.match(line, /high=0/);
    assert.match(line, /4 used/);
    assert.match(line, /1 disabled/);
    assert.match(line, /selected from medium/);
  });

  it("says so plainly when nothing was withheld", () => {
    const diagnostic = emptyPriorityDiagnostic();
    diagnostic.offered = { high: 3, medium: 0, unclassified: 0 };
    assert.match(describePrioritySelection(diagnostic), /none withheld/);
  });
});
