import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeExtractionHash,
  extractionExcerpt,
  parseExtractionResponse,
  ExtractionParseError,
  MAX_EXTRACTION_CONTENT_CHARS,
  type ExtractableContent,
} from "./competitor-intelligence-extraction";

const FULL_VALID_REPLY = {
  topic: "Home insulation",
  subtopic: "Attic insulation",
  summary: "A short guide to insulating an attic before winter.",
  angle: "Positions DIY insulation as a weekend project anyone can do.",
  hookType: "question",
  structurePattern: "how_to",
  targetAudience: "Homeowners in older houses",
  problemAddressed: "High heating bills from poor insulation",
  keyMessage: "Insulating your attic pays for itself in one winter.",
  tone: "friendly and practical",
  ctaText: "Book a free home energy audit",
  contentType: "guide",
  commercialIntent: "soft_sell",
  ctaType: "learn_more",
  angleCategory: "how_to",
  productsServicesMentioned: ["Home Energy Audit"],
  originalLanguage: "en",
};

describe("extractionExcerpt", () => {
  it("returns the trimmed body untouched when it fits under the cap", () => {
    const content: ExtractableContent = { title: "T", body: "  short body  " };
    assert.equal(extractionExcerpt(content), "short body");
  });

  it("truncates content beyond the cap", () => {
    const content: ExtractableContent = {
      title: null,
      body: "x".repeat(MAX_EXTRACTION_CONTENT_CHARS + 500),
    };
    const excerpt = extractionExcerpt(content);
    assert.equal(excerpt.length, MAX_EXTRACTION_CONTENT_CHARS);
  });
});

describe("computeExtractionHash", () => {
  it("is deterministic for identical input", () => {
    const a: ExtractableContent = { title: "T", body: "Body text." };
    const b: ExtractableContent = { title: "T", body: "Body text." };
    assert.equal(computeExtractionHash(a, "en"), computeExtractionHash(b, "en"));
  });

  it("changes when the body changes, even beyond the excerpt cap", () => {
    const base = "x".repeat(MAX_EXTRACTION_CONTENT_CHARS + 100);
    const a: ExtractableContent = { title: "T", body: `${base}A` };
    const b: ExtractableContent = { title: "T", body: `${base}B` };
    // The excerpt sent to the model is identical (both truncate to the same
    // prefix), but the hash must still change — it fingerprints the FULL
    // input, not merely what was sent, per the module's own contract.
    assert.equal(extractionExcerpt(a), extractionExcerpt(b));
    assert.notEqual(computeExtractionHash(a, "en"), computeExtractionHash(b, "en"));
  });

  it("changes when the title changes", () => {
    const a: ExtractableContent = { title: "One title", body: "Body text." };
    const b: ExtractableContent = { title: "Another title", body: "Body text." };
    assert.notEqual(computeExtractionHash(a, "en"), computeExtractionHash(b, "en"));
  });
});

describe("parseExtractionResponse", () => {
  it("accepts a fully-specified, valid reply", () => {
    const outcome = parseExtractionResponse(JSON.stringify(FULL_VALID_REPLY));
    assert.equal(outcome.status, "ok");
    if (outcome.status !== "ok") return;
    assert.equal(outcome.topic, "Home insulation");
    assert.equal(outcome.hookType, "question");
    assert.equal(outcome.contentType, "guide");
    assert.deepEqual(outcome.productsServicesMentioned, ["Home Energy Audit"]);
  });

  it("accepts every field as null/empty when the content genuinely offers nothing", () => {
    const reply = {
      topic: null,
      subtopic: null,
      summary: null,
      angle: null,
      hookType: null,
      structurePattern: null,
      targetAudience: null,
      problemAddressed: null,
      keyMessage: null,
      tone: null,
      ctaText: null,
      contentType: null,
      commercialIntent: null,
      ctaType: null,
      angleCategory: null,
      productsServicesMentioned: [],
      originalLanguage: null,
    };
    const outcome = parseExtractionResponse(JSON.stringify(reply));
    assert.equal(outcome.status, "ok");
  });

  it("rejects an invented enum value for each enum field", () => {
    for (const field of [
      "hookType",
      "structurePattern",
      "contentType",
      "commercialIntent",
      "ctaType",
      "angleCategory",
    ]) {
      const reply = { ...FULL_VALID_REPLY, [field]: "not_a_real_value" };
      const outcome = parseExtractionResponse(JSON.stringify(reply));
      assert.equal(outcome.status, "invalid", `${field} should be rejected`);
    }
  });

  it("rejects prose instead of JSON", () => {
    const outcome = parseExtractionResponse("Sure, here is my analysis: it's about insulation.");
    assert.equal(outcome.status, "invalid");
  });

  it("rejects malformed JSON", () => {
    const outcome = parseExtractionResponse("{ topic: 'insulation' ");
    assert.equal(outcome.status, "invalid");
  });

  it("rejects a JSON array", () => {
    const outcome = parseExtractionResponse("[1,2,3]");
    assert.equal(outcome.status, "invalid");
  });

  it("throws ExtractionParseError on an empty response", () => {
    assert.throws(() => parseExtractionResponse(""), ExtractionParseError);
    assert.throws(() => parseExtractionResponse(null), ExtractionParseError);
  });

  it("never fabricates productsServicesMentioned from a non-array value", () => {
    const reply = { ...FULL_VALID_REPLY, productsServicesMentioned: "Home Energy Audit" };
    const outcome = parseExtractionResponse(JSON.stringify(reply));
    assert.equal(outcome.status, "ok");
    if (outcome.status === "ok") assert.deepEqual(outcome.productsServicesMentioned, []);
  });
});
