import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  COMPANY_MISSION_VALUE,
  COMPANY_RULES_VALUE,
  isSelectedSourceUsable,
  parseManualContentSource,
  toSourceScope,
  type ManualContentSourceSelection,
} from "./manual-content-source";
import type { FeedItemContext } from "./types";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function article(id: string): FeedItemContext {
  return { id, title: "t", content: "c", url: "https://example.com/a", publishedAt: null };
}

function evergreen(id: string): FeedItemContext {
  return { ...article(id), consumable: false };
}

describe("parseManualContentSource", () => {
  it("defaults to company rules when the field is absent", () => {
    // A client that never sends the field — and every caller that predates it —
    // must keep the pooled behaviour the form has always had.
    assert.deepEqual(parseManualContentSource(undefined), { kind: "company_rules" });
    assert.deepEqual(parseManualContentSource(null), { kind: "company_rules" });
    assert.deepEqual(parseManualContentSource(""), { kind: "company_rules" });
  });

  it("reads the company-rules sentinel", () => {
    assert.deepEqual(parseManualContentSource(COMPANY_RULES_VALUE), { kind: "company_rules" });
  });

  it("reads the company-mission sentinel", () => {
    assert.deepEqual(parseManualContentSource(COMPANY_MISSION_VALUE), { kind: "company_mission" });
  });

  it("treats any other value as a content source id", () => {
    assert.deepEqual(parseManualContentSource("f81d4fae-7dec-11d0-a765-00a0c91e6bf6"), {
      kind: "source",
      sourceId: "f81d4fae-7dec-11d0-a765-00a0c91e6bf6",
    });
  });

  it("keeps the sentinels apart from any real source id", () => {
    // The sentinels are not uuids, so a source can never be shadowed by one.
    for (const sentinel of [COMPANY_RULES_VALUE, COMPANY_MISSION_VALUE]) {
      assert.equal(parseManualContentSource(sentinel).kind !== "source", true);
    }
  });
});

describe("toSourceScope", () => {
  it("maps company rules to the pooled scope (the pre-existing behaviour)", () => {
    // Pooled is what the manual flow has always used: every enabled source,
    // newest articles first, with the reservation and anti-repetition guards
    // downstream untouched.
    assert.deepEqual(toSourceScope({ kind: "company_rules" }), { kind: "pooled" });
  });

  it("maps a picked source to that source alone", () => {
    assert.deepEqual(toSourceScope({ kind: "source", sourceId: "src-1" }), {
      kind: "source",
      sourceId: "src-1",
    });
  });

  it("maps company mission to the no-source scope", () => {
    // company_content gives the context an empty article window AND no article
    // sources, which is exactly what drives the mission/brand post path.
    assert.deepEqual(toSourceScope({ kind: "company_mission" }), { kind: "company_content" });
  });
});

describe("isSelectedSourceUsable", () => {
  const pickedSource: ManualContentSourceSelection = { kind: "source", sourceId: "src-1" };

  it("accepts a picked source that still has an unused article", () => {
    assert.equal(isSelectedSourceUsable(pickedSource, [article("a-1")]), true);
  });

  it("rejects a picked source with no articles left", () => {
    // The window is already scoped to the source, so empty means this source is
    // dry — the case the form shows as "(No new articles)".
    assert.equal(isSelectedSourceUsable(pickedSource, []), false);
  });

  it("rejects a picked source whose only items are evergreen", () => {
    // An RSS pick must produce an article post. Evergreen items are reusable
    // context, not the article the user asked to write about.
    assert.equal(isSelectedSourceUsable(pickedSource, [evergreen("e-1")]), false);
  });

  it("never blocks company rules, even with no articles anywhere", () => {
    // Company rules delegates to the existing pooled logic, which decides for
    // itself between an article, an evergreen item, a mission post, or a skip.
    assert.equal(isSelectedSourceUsable({ kind: "company_rules" }, []), true);
  });

  it("never blocks company mission, which needs no source at all", () => {
    assert.equal(isSelectedSourceUsable({ kind: "company_mission" }, []), true);
  });
});
