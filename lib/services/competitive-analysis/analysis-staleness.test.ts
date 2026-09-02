import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  analysisStaleness,
  extractableContentOf,
  isStaleAnalysis,
  type StaleAnalysisCandidate,
} from "./analysis-staleness";
import { computeExtractionHash } from "@/lib/ai/competitor-intelligence-extraction";

const FEED = { title: "Heat pumps in 2026", content: "A long article about heat pumps." };

function feedRow(analysisHash: string | null): StaleAnalysisCandidate {
  return { analysisHash, feedItem: FEED, manualEntry: null };
}

const currentHash = (language: "en" | "bg") =>
  computeExtractionHash({ title: FEED.title, body: FEED.content }, language);

describe("extractableContentOf", () => {
  it("derives a feed item exactly the way the extractor does", () => {
    assert.deepEqual(extractableContentOf({ feedItem: FEED, manualEntry: null }), {
      title: FEED.title,
      body: FEED.content,
    });
  });

  it("treats a null feed body as an empty body, never as a missing origin", () => {
    assert.deepEqual(
      extractableContentOf({ feedItem: { title: "T", content: null }, manualEntry: null }),
      { title: "T", body: "" }
    );
  });

  it("derives a manual entry with no title", () => {
    assert.deepEqual(
      extractableContentOf({ feedItem: null, manualEntry: { content: "Pasted." } }),
      {
        title: null,
        body: "Pasted.",
      }
    );
  });

  it("prefers the feed item when both are somehow present", () => {
    // The DB's XOR CHECK constraint makes this unreachable, but the ordering
    // must still match the extractor's, or the two would hash different text.
    assert.deepEqual(extractableContentOf({ feedItem: FEED, manualEntry: { content: "other" } }), {
      title: FEED.title,
      body: FEED.content,
    });
  });

  it("returns null when there is no readable origin at all", () => {
    assert.equal(extractableContentOf({ feedItem: null, manualEntry: null }), null);
  });
});

describe("analysisStaleness", () => {
  it("(2) a row analyzed under the CURRENT language and semantics is not stale", () => {
    assert.equal(analysisStaleness(feedRow(currentHash("bg")), "bg"), "current");
    assert.equal(analysisStaleness(feedRow(currentHash("en")), "en"), "current");
  });

  it("(1) a v1 English row is stale once the company analyses in Bulgarian", () => {
    // The exact production shape: the row's stored hash is the one the English
    // extractor wrote; the company's analysis language is now Bulgarian.
    assert.equal(analysisStaleness(feedRow(currentHash("en")), "bg"), "stale_hash");
  });

  it("(3) the language alone changes the hash — same content, same version", () => {
    assert.notEqual(currentHash("en"), currentHash("bg"));
  });

  it("detects content that changed underneath a completed analysis", () => {
    const row: StaleAnalysisCandidate = {
      analysisHash: computeExtractionHash({ title: FEED.title, body: "an older body" }, "bg"),
      feedItem: FEED,
      manualEntry: null,
    };
    assert.equal(analysisStaleness(row, "bg"), "stale_hash");
  });

  it("treats a completed row with no fingerprint as stale, not as current", () => {
    assert.equal(analysisStaleness(feedRow(null), "bg"), "missing_hash");
    assert.equal(analysisStaleness(feedRow("   "), "bg"), "missing_hash");
  });

  it("leaves a row with no readable origin alone — re-opening could not help it", () => {
    const orphan: StaleAnalysisCandidate = {
      analysisHash: null,
      feedItem: null,
      manualEntry: null,
    };
    assert.equal(analysisStaleness(orphan, "bg"), "unanalyzable");
    assert.equal(isStaleAnalysis("unanalyzable"), false);
  });

  it("is idempotent: re-hashing what a re-analysis would store yields `current`", () => {
    // (10) The whole idempotency guarantee in one assertion — whatever the
    // extractor writes on success is exactly what this recomputes afterwards,
    // so the next sweep finds nothing to do.
    const afterReanalysis = feedRow(currentHash("bg"));
    assert.equal(analysisStaleness(afterReanalysis, "bg"), "current");
    assert.equal(analysisStaleness(afterReanalysis, "bg"), "current");
  });
});

describe("isStaleAnalysis", () => {
  it("re-opens only the two verdicts that warrant a fresh model call", () => {
    assert.equal(isStaleAnalysis("stale_hash"), true);
    assert.equal(isStaleAnalysis("missing_hash"), true);
    assert.equal(isStaleAnalysis("current"), false);
    assert.equal(isStaleAnalysis("unanalyzable"), false);
  });
});
