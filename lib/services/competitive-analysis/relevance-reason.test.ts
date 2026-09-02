import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  RELEVANCE_REASON_CODES,
  relevanceReasonCodeValue,
  resolveRelevanceReason,
} from "./relevance-reason";

describe("relevanceReasonCodeValue", () => {
  it("stores a canonical token, never a localized sentence", () => {
    // The database must never hold Bulgarian for a machine-written value —
    // §2/§4 of the governing instruction. Localization happens at display.
    assert.equal(relevanceReasonCodeValue("no_research_interests"), "code:no_research_interests");
    assert.equal(relevanceReasonCodeValue("attempts_exhausted"), "code:attempts_exhausted");
  });

  it("round-trips through resolveRelevanceReason for every declared code", () => {
    for (const code of RELEVANCE_REASON_CODES) {
      assert.deepEqual(resolveRelevanceReason(relevanceReasonCodeValue(code)), {
        kind: "code",
        code,
      });
    }
  });
});

describe("resolveRelevanceReason", () => {
  it("treats the model's own sentence as text, in whatever language it was written", () => {
    // Free-form analysis text is already produced in the company's analysis
    // language (see analysis-language.ts) — the UI renders it verbatim.
    assert.deepEqual(resolveRelevanceReason("Centrally about heat pumps."), {
      kind: "text",
      text: "Centrally about heat pumps.",
    });
    assert.deepEqual(resolveRelevanceReason("Съдържанието е изцяло за термопомпи."), {
      kind: "text",
      text: "Съдържанието е изцяло за термопомпи.",
    });
  });

  it("recognizes the English sentences stored BEFORE this fix", () => {
    // This is what makes existing rows localize with no migration, no backfill
    // and no re-analysis (§5) for the deterministic reasons.
    assert.deepEqual(resolveRelevanceReason("No research topics or markets are configured."), {
      kind: "code",
      code: "no_research_interests",
    });
    assert.deepEqual(
      resolveRelevanceReason(
        "Relevance evaluation failed after 3 attempts against this Research Profile version."
      ),
      { kind: "code", code: "attempts_exhausted" }
    );
  });

  it("recognizes the legacy exhausted-attempts sentence whatever attempt count it names", () => {
    // MAX_RELEVANCE_ATTEMPTS has changed before; old rows keep the old number.
    for (const n of [1, 2, 3, 5, 10]) {
      assert.deepEqual(
        resolveRelevanceReason(
          `Relevance evaluation failed after ${n} attempts against this Research Profile version.`
        ),
        { kind: "code", code: "attempts_exhausted" }
      );
    }
  });

  it("does not mistake a similar model sentence for a legacy code", () => {
    // The legacy match is anchored, not a substring search — a model that
    // happens to write about a research profile must stay free-form text.
    const sentence = "No research topics or markets are configured for this competitor's sector.";
    assert.deepEqual(resolveRelevanceReason(sentence), { kind: "text", text: sentence });
  });

  it("returns null for an absent reason", () => {
    assert.equal(resolveRelevanceReason(null), null);
    assert.equal(resolveRelevanceReason(undefined), null);
    assert.equal(resolveRelevanceReason("   "), null);
  });

  it("degrades an unknown code: token to text rather than dropping it", () => {
    // A reason written by a future version this build does not know about is
    // still more truthful to show than an empty section.
    assert.deepEqual(resolveRelevanceReason("code:something_new"), {
      kind: "text",
      text: "code:something_new",
    });
  });
});
