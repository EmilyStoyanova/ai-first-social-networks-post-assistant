import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildExtractionPrompts,
  computeExtractionHash,
  ExtractionParseError,
  extractionInstructionsOf,
  NOT_FOUND_MARKER,
  parseExtractionResponse,
} from "./product-page-extraction";

const INSTRUCTION = "Extract all events for the next calendar week, with type, date and price.";
const PAGE = "Energy Update — webinar, 11.08.2026, free\nHR Meetup — meetup, 16.08.2026";

describe("product-page extraction — the extraction hash", () => {
  it("is stable for the same page and instruction, so a re-scrape costs no model call", () => {
    assert.equal(
      computeExtractionHash(PAGE, INSTRUCTION),
      computeExtractionHash(PAGE, INSTRUCTION)
    );
  });

  it("changes when the page changes — new events must be re-extracted", () => {
    assert.notEqual(
      computeExtractionHash(PAGE, INSTRUCTION),
      computeExtractionHash(`${PAGE}\nA third event`, INSTRUCTION)
    );
  });

  it("changes when the instruction changes against an unchanged page", () => {
    assert.notEqual(
      computeExtractionHash(PAGE, INSTRUCTION),
      computeExtractionHash(PAGE, "Extract only the free events.")
    );
  });

  it("treats a page that could not be read as its own input", () => {
    assert.equal(
      computeExtractionHash(null, INSTRUCTION),
      computeExtractionHash(null, INSTRUCTION)
    );
    assert.notEqual(computeExtractionHash(null, INSTRUCTION), computeExtractionHash("", "x"));
  });
});

describe("product-page extraction — reading the instruction off a source config", () => {
  it("reads and trims a configured instruction", () => {
    assert.equal(
      extractionInstructionsOf({ url: "u", extractionInstructions: "  List all.  " }),
      "List all."
    );
  });

  it("is null for a config written before the field existed", () => {
    assert.equal(extractionInstructionsOf({ url: "https://example.com" }), null);
  });

  it("is null for a blank, non-string, or absent value", () => {
    assert.equal(extractionInstructionsOf({ extractionInstructions: "   " }), null);
    assert.equal(extractionInstructionsOf({ extractionInstructions: 42 }), null);
    assert.equal(extractionInstructionsOf(null), null);
    assert.equal(extractionInstructionsOf("not an object"), null);
  });
});

describe("product-page extraction — classifying the model's reply", () => {
  it("keeps a real extraction verbatim, including its structure", () => {
    const reply = "Total events: 2\n\n1. Energy Update\n   Type: Webinar\n   Price: Free";
    const outcome = parseExtractionResponse(reply);

    assert.equal(outcome.status, "completed");
    assert.equal(outcome.status === "completed" ? outcome.content : "", reply);
  });

  it("recognises the not-found answer and keeps its reason", () => {
    // The case that matters most: a page listing THIS week against an instruction
    // asking for NEXT week. An invented list would be worse than no post.
    const outcome = parseExtractionResponse(
      `${NOT_FOUND_MARKER}: The page lists only events for the current week.`
    );

    assert.equal(outcome.status, "not_found");
    assert.equal(
      outcome.status === "not_found" ? outcome.reason : "",
      "The page lists only events for the current week."
    );
  });

  it("accepts the marker with a leading heading fragment on the same line", () => {
    const outcome = parseExtractionResponse(`- ${NOT_FOUND_MARKER} — nothing next week.`);

    assert.equal(outcome.status, "not_found");
  });

  it("does not read a mention of the marker further down as an empty result", () => {
    // A completed list that happens to quote the phrase is still a completed list.
    const outcome = parseExtractionResponse(
      `1. Energy Update — webinar\n(price ${NOT_FOUND_MARKER} for this one)`
    );

    assert.equal(outcome.status, "completed");
  });

  it("rejects an empty reply rather than storing it as an extraction", () => {
    assert.throws(() => parseExtractionResponse("   "), ExtractionParseError);
    assert.throws(() => parseExtractionResponse(null), ExtractionParseError);
  });
});

describe("product-page extraction — the prompts", () => {
  const prompts = buildExtractionPrompts({
    instructions: INSTRUCTION,
    pageText: PAGE,
    pageTitle: "Business events",
    pageUrl: "https://events.example.com/?week=current",
    today: new Date("2026-08-13T09:00:00.000Z"),
  });

  it("forbids adding anything the page does not state", () => {
    assert.match(prompts.systemPrompt, /ONLY information that is literally present/);
    assert.match(prompts.systemPrompt, /Never add an item, a date, a price/);
  });

  it("requires every matching item, not a representative one", () => {
    assert.match(prompts.systemPrompt, /Include EVERY item/);
    assert.match(prompts.systemPrompt, /do not keep one as an example/i);
  });

  it("gives the model today's date so a relative period resolves", () => {
    assert.match(prompts.userPrompt, /2026-08-13 \(Thursday\)/);
  });

  it("says that resolving a date range is not permission to invent entries in it", () => {
    // The exact failure mode of "next week" against a `week=current` page.
    assert.match(prompts.userPrompt, /does NOT mean the page contains events in it/);
  });

  it("names the empty answer as an acceptable, correct outcome", () => {
    assert.ok(prompts.systemPrompt.includes(NOT_FOUND_MARKER));
    assert.match(prompts.systemPrompt, /an empty result is correct and useful/);
  });

  it("carries the instruction and the page text, and marks the page as the only source", () => {
    assert.ok(prompts.userPrompt.includes(INSTRUCTION));
    assert.ok(prompts.userPrompt.includes(PAGE));
    assert.match(prompts.userPrompt, /the only permitted source of facts/);
  });

  it("asks for plain text, because the instruction is free-form", () => {
    assert.match(prompts.systemPrompt, /Answer in plain text/);
    assert.match(prompts.systemPrompt, /No JSON/);
  });
});
