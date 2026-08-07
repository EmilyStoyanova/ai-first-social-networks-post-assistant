import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  COMPANY_MISSION_VALUE,
  COMPANY_RULES_VALUE,
  isPickedSource,
  isSelectedSourceUsable,
  parseManualContentSource,
  resolveManualContentSource,
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

describe("resolveManualContentSource", () => {
  it("resolves an rss source to the reservation path", () => {
    assert.deepEqual(resolveManualContentSource({ kind: "source", sourceId: "src-1" }, "rss"), {
      kind: "rss_source",
      sourceId: "src-1",
    });
  });

  it("resolves a product page to the direct content-source path", () => {
    assert.deepEqual(
      resolveManualContentSource({ kind: "source", sourceId: "src-1" }, "product_page"),
      { kind: "content_source", sourceId: "src-1", sourceType: "product_page" }
    );
  });

  it("resolves prompt and calendar sources to the direct path too", () => {
    // Everything that is not RSS is read from its stored extraction; only RSS
    // reserves an article.
    for (const type of ["prompt", "calendar_event"]) {
      const resolved = resolveManualContentSource({ kind: "source", sourceId: "src-1" }, type);
      assert.deepEqual(resolved, { kind: "content_source", sourceId: "src-1", sourceType: type });
    }
  });

  it("passes the sentinels through untouched, ignoring any type", () => {
    assert.deepEqual(resolveManualContentSource({ kind: "company_rules" }, null), {
      kind: "company_rules",
    });
    assert.deepEqual(resolveManualContentSource({ kind: "company_mission" }, null), {
      kind: "company_mission",
    });
  });

  it("refuses a source that could not be resolved", () => {
    // Deleted, disabled, or another company's. Null rather than a fallback: an
    // explicit pick that cannot be honoured must be reported, not substituted.
    assert.equal(resolveManualContentSource({ kind: "source", sourceId: "src-1" }, null), null);
  });

  it("takes the kind from the type it is given, never from the id", () => {
    // The whole reason resolution is a separate step: the wire carries an id,
    // and the database says what that id IS. Same id, different path.
    const ref = { kind: "source", sourceId: "src-1" } as const;
    assert.equal(resolveManualContentSource(ref, "rss")?.kind, "rss_source");
    assert.equal(resolveManualContentSource(ref, "product_page")?.kind, "content_source");
  });
});

describe("isPickedSource", () => {
  it("is true for both source kinds and false for the sentinels", () => {
    assert.equal(isPickedSource({ kind: "rss_source", sourceId: "s" }), true);
    assert.equal(
      isPickedSource({ kind: "content_source", sourceId: "s", sourceType: "product_page" }),
      true
    );
    assert.equal(isPickedSource({ kind: "company_rules" }), false);
    assert.equal(isPickedSource({ kind: "company_mission" }), false);
  });
});

describe("toSourceScope", () => {
  it("maps company rules to the pooled scope (the pre-existing behaviour)", () => {
    // Pooled is what the manual flow has always used: every enabled source,
    // newest articles first, with the reservation and anti-repetition guards
    // downstream untouched.
    assert.deepEqual(toSourceScope({ kind: "company_rules" }), { kind: "pooled" });
  });

  it("maps a picked RSS source to that source's article window", () => {
    assert.deepEqual(toSourceScope({ kind: "rss_source", sourceId: "src-1" }), {
      kind: "source",
      sourceId: "src-1",
    });
  });

  it("maps a picked non-RSS source to the direct content-source scope", () => {
    // A different scope, not the same one with a flag: this window drops the
    // one-post-per-article filter, which the RSS window must keep.
    assert.deepEqual(
      toSourceScope({ kind: "content_source", sourceId: "src-1", sourceType: "product_page" }),
      { kind: "content_source", sourceId: "src-1" }
    );
  });

  it("maps company mission to the no-source scope", () => {
    // company_content gives the context an empty article window AND no article
    // sources, which is exactly what drives the mission/brand post path.
    assert.deepEqual(toSourceScope({ kind: "company_mission" }), { kind: "company_content" });
  });
});

describe("isSelectedSourceUsable", () => {
  const pickedRss: ManualContentSourceSelection = { kind: "rss_source", sourceId: "src-1" };
  const pickedPage: ManualContentSourceSelection = {
    kind: "content_source",
    sourceId: "src-1",
    sourceType: "product_page",
  };

  it("accepts a picked RSS source that still has an unused article", () => {
    assert.equal(isSelectedSourceUsable(pickedRss, [article("a-1")]), true);
  });

  it("rejects a picked RSS source with no articles left", () => {
    // The window is already scoped to the source, so empty means this source is
    // dry — the case the form shows as "(No new articles)".
    assert.equal(isSelectedSourceUsable(pickedRss, []), false);
  });

  it("rejects a picked RSS source whose only items are evergreen", () => {
    // An RSS pick must produce an article post. Evergreen items are reusable
    // context, not the article the user asked to write about.
    assert.equal(isSelectedSourceUsable(pickedRss, [evergreen("e-1")]), false);
  });

  it("accepts a picked content source with stored content", () => {
    assert.equal(isSelectedSourceUsable(pickedPage, [article("a-1")]), true);
  });

  it("accepts a picked content source whose stored item is evergreen", () => {
    // A prompt or calendar source has nothing but evergreen items, and reading
    // it directly is exactly what the user asked for.
    assert.equal(isSelectedSourceUsable(pickedPage, [evergreen("e-1")]), true);
  });

  it("rejects a picked content source with nothing extracted", () => {
    // The window is not filtered by usedInPost, so empty means never fetched —
    // the case the form shows as "(No extracted content)".
    assert.equal(isSelectedSourceUsable(pickedPage, []), false);
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
