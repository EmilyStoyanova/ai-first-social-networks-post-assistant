import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildExtractionPrompts,
  buildExtractionRepairPrompt,
  computeExtractionHash,
  ExtractionParseError,
  extractionInstructionsOf,
  findJsonObject,
  MAX_EXTRACTION_REPAIR_ATTEMPTS,
  NOT_FOUND_MARKER,
  normaliseFieldValue,
  parseExtractionResponse,
  renderExtraction,
  UNKNOWN_FIELD_VALUE,
  validateExtraction,
  type StructuredExtraction,
} from "./product-page-extraction";
import { PAGE_TEXT_TRUNCATION_MARKER } from "@/lib/integrations/product-page/scraper";

const INSTRUCTION = "Extract all events for the next calendar week, with type, date and price.";
const PAGE = "Energy Update — webinar, 11.08.2026, free\nHR Meetup — meetup, 16.08.2026";

/** The reply shape the model is asked for, as a well-behaved model returns it. */
function reply(items: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    requestedFields: ["type", "date", "price"],
    items,
    sourceStatedCount: null,
    notes: null,
    ...extra,
  });
}

const EVENT_A = {
  label: "Energy Update",
  fields: { type: "Webinar", date: "18.08.2026", price: "Free" },
};
const EVENT_B = {
  label: "HR Masterclass",
  fields: { type: "Masterclass", date: "19.08.2026", price: "50 BGN" },
};

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

describe("product-page extraction — finding the JSON in a reply", () => {
  it("reads a bare object", () => {
    assert.equal(findJsonObject('{"items":[]}'), '{"items":[]}');
  });

  it("reads it out of markdown fences and a preamble", () => {
    const raw = 'Here is the result:\n```json\n{"items":[1]}\n```\nHope that helps.';

    assert.equal(findJsonObject(raw), '{"items":[1]}');
  });

  it("skips a reasoning block a self-hosted model emits before its answer", () => {
    // Rejecting these would spend the one repair call on punctuation.
    const raw = '<think>The page lists two {events}.</think>{"items":[1]}';

    assert.equal(findJsonObject(raw), '{"items":[1]}');
  });

  it("keeps nested objects and braces inside strings", () => {
    const raw = '{"a":{"b":1},"c":"a } brace"} trailing';

    assert.equal(findJsonObject(raw), '{"a":{"b":1},"c":"a } brace"}');
  });

  it("is null for prose with no object at all", () => {
    assert.equal(findJsonObject("There are two events this week."), null);
  });
});

describe("product-page extraction — normalising a field value", () => {
  it("keeps a stated value as the page words it", () => {
    assert.equal(normaliseFieldValue("50 BGN"), "50 BGN");
  });

  it("maps every spelling of absent onto one marker, so the gap is countable", () => {
    for (const spelling of ["N/A", "unknown", "not provided", "—", "", "  ", null, undefined]) {
      assert.equal(normaliseFieldValue(spelling), UNKNOWN_FIELD_VALUE, `for ${String(spelling)}`);
    }
  });

  it("flattens a list and a number rather than losing them", () => {
    assert.equal(normaliseFieldValue(["Sofia", "Online"]), "Sofia, Online");
    assert.equal(normaliseFieldValue(50), "50");
    assert.equal(normaliseFieldValue(true), "yes");
  });
});

describe("product-page extraction — classifying the model's reply", () => {
  it("accepts a well-formed reply and keeps every item and field", () => {
    const outcome = parseExtractionResponse(reply([EVENT_A, EVENT_B]));

    assert.equal(outcome.status, "completed");
    if (outcome.status !== "completed") return;
    assert.equal(outcome.data.items.length, 2);
    assert.deepEqual(outcome.data.items[1].fields, EVENT_B.fields);
    assert.ok(outcome.content.includes("Energy Update"));
    assert.ok(outcome.content.includes("50 BGN"));
  });

  it("accepts the flat item shape a smaller model produces", () => {
    // `{label, type, date, price}` rather than a nested `fields` object. The
    // facts are all there; rejecting the punctuation would waste the repair call.
    const outcome = parseExtractionResponse(
      reply([{ name: "Energy Update", type: "Webinar", date: "18.08.2026", price: "Free" }])
    );

    assert.equal(outcome.status, "completed");
    if (outcome.status !== "completed") return;
    assert.equal(outcome.data.items[0].label, "Energy Update");
    assert.equal(outcome.data.items[0].fields.price, "Free");
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

  it("accepts the not-found answer as a field, for a model that JSONs everything", () => {
    const outcome = parseExtractionResponse('{"notFound":"The page lists only this week."}');

    assert.equal(outcome.status, "not_found");
  });

  it("does not read a mention of the marker further down as an empty result", () => {
    // A completed list that happens to quote the phrase is still a completed list.
    const outcome = parseExtractionResponse(
      reply([{ ...EVENT_A, fields: { ...EVENT_A.fields, price: NOT_FOUND_MARKER } }])
    );

    assert.equal(outcome.status, "completed");
  });

  it("rejects an empty reply rather than storing it as an extraction", () => {
    assert.throws(() => parseExtractionResponse("   "), ExtractionParseError);
    assert.throws(() => parseExtractionResponse(null), ExtractionParseError);
  });

  it("rejects prose, and says what to do about it", () => {
    const outcome = parseExtractionResponse("There are two events this week: Energy Update and…");

    assert.equal(outcome.status, "invalid");
    assert.match(outcome.status === "invalid" ? outcome.feedback : "", /SINGLE JSON object/);
  });

  it("rejects malformed JSON rather than salvaging half a list", () => {
    const outcome = parseExtractionResponse('{"items":[{"label":"Energy Update",}');

    assert.equal(outcome.status, "invalid");
  });

  it("rejects a reply with no items that did not say the page was empty", () => {
    const outcome = parseExtractionResponse(reply([]));

    assert.equal(outcome.status, "invalid");
    assert.match(outcome.status === "invalid" ? outcome.feedback : "", /NOT_FOUND_IN_SOURCE/);
  });

  it("rejects an item with no name — usually half a truncated card", () => {
    const outcome = parseExtractionResponse(reply([EVENT_A, { fields: { type: "Webinar" } }]));

    assert.equal(outcome.status, "invalid");
    assert.match(outcome.status === "invalid" ? outcome.problem : "", /no name/);
  });
});

describe("product-page extraction — completeness checks", () => {
  function extraction(over: Partial<StructuredExtraction> = {}): StructuredExtraction {
    return {
      requestedFields: ["type", "date", "price"],
      items: [EVENT_A, EVENT_B],
      sourceStatedCount: null,
      notes: null,
      ...over,
    };
  }

  it("passes a list where every item carries every requested field", () => {
    assert.deepEqual(validateExtraction(extraction()), { ok: true });
  });

  it("rejects the item that lost a field its siblings kept", () => {
    // The reported failure: the model tires, and the last events arrive with
    // fewer details than the first. Free-form prose cannot show this.
    const verdict = validateExtraction(
      extraction({ items: [EVENT_A, { label: "HR Masterclass", fields: { type: "Masterclass" } }] })
    );

    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.match(verdict.problem, /HR Masterclass/);
    assert.match(verdict.feedback, /date, price/);
  });

  it("compares field names loosely, so priceStatus and 'price status' are one field", () => {
    const verdict = validateExtraction(
      extraction({
        requestedFields: ["price status"],
        items: [{ label: "A", fields: { priceStatus: "Free" } }],
      })
    );

    assert.equal(verdict.ok, true);
  });

  it("accepts an explicit unknown — a looked-for field the page does not state", () => {
    const verdict = validateExtraction(
      extraction({
        items: [{ label: "A", fields: { type: "Webinar", date: "18.08", price: "not stated" } }],
      })
    );

    assert.equal(verdict.ok, true);
  });

  it("rejects a list shorter than the count the page itself prints", () => {
    const verdict = validateExtraction(extraction({ sourceStatedCount: 5 }));

    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.match(verdict.problem, /states 5 items but only 2/);
    assert.match(verdict.feedback, /Do not invent an item to reach the number/);
  });

  it("does not chase a shortfall the scrape itself caused", () => {
    // The page says thirty and the captured text holds two. No reply can close
    // that gap, and retrying would spend every attempt discovering so.
    const verdict = validateExtraction(extraction({ sourceStatedCount: 30 }), {
      pageTextTruncated: true,
    });

    assert.equal(verdict.ok, true);
  });

  it("does not treat MORE items than the page's count as an error", () => {
    // A banner saying "5 events" over six cards is a stale banner, not data loss.
    const verdict = validateExtraction(extraction({ sourceStatedCount: 1 }));

    assert.equal(verdict.ok, true);
  });

  it("names only the first few offenders, so the repair prompt stays readable", () => {
    const verdict = validateExtraction(
      extraction({
        items: Array.from({ length: 9 }, (_, i) => ({ label: `Item ${i}`, fields: {} })),
      })
    );

    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.match(verdict.problem, /and 4 more/);
  });

  it("falls back to the first item's fields when the model declared none", () => {
    // Silence about which fields were asked for must not switch the check off.
    const outcome = parseExtractionResponse(
      reply([EVENT_A, { label: "HR Masterclass", fields: { type: "Masterclass" } }], {
        requestedFields: [],
      })
    );

    assert.equal(outcome.status, "invalid");
  });
});

describe("product-page extraction — the totals are computed, not quoted", () => {
  it("counts the items it actually holds", () => {
    const content = renderExtraction({
      requestedFields: ["type"],
      items: [EVENT_A, EVENT_B],
      // A model's own claim of five is ignored — the list is what it is.
      sourceStatedCount: 5,
      notes: null,
    });

    assert.match(content, /^Total items extracted: 2$/m);
  });

  it("breaks a repeating field down by value, so 'how many free' is arithmetic", () => {
    const content = renderExtraction({
      requestedFields: ["type", "price status"],
      items: [
        { label: "A", fields: { type: "Webinar", "price status": "Free" } },
        { label: "B", fields: { type: "Webinar", "price status": "Paid" } },
        { label: "C", fields: { type: "Meetup", "price status": "Free" } },
      ],
      sourceStatedCount: null,
      notes: null,
    });

    assert.match(content, /type — Webinar: 2, Meetup: 1/);
    assert.match(content, /price status — Free: 2, Paid: 1/);
  });

  it("does not break down a field that is different for every item", () => {
    // Counting five dates over five events is noise, not a total.
    const content = renderExtraction({
      requestedFields: ["date"],
      items: [
        { label: "A", fields: { date: "18.08" } },
        { label: "B", fields: { date: "19.08" } },
      ],
      sourceStatedCount: null,
      notes: null,
    });

    assert.ok(!content.includes("date — "));
  });

  it("writes every item with every one of its fields", () => {
    const content = renderExtraction({
      requestedFields: ["type", "date", "price"],
      items: [EVENT_A, EVENT_B],
      sourceStatedCount: null,
      notes: "Registration closes on Friday.",
    });

    assert.match(content, /1\. Energy Update/);
    assert.match(content, /2\. HR Masterclass/);
    assert.match(content, /price: 50 BGN/);
    assert.match(content, /Registration closes on Friday/);
  });

  it("shows an unstated field as unstated rather than leaving it out", () => {
    const content = renderExtraction({
      requestedFields: ["price"],
      items: [{ label: "A", fields: { price: UNKNOWN_FIELD_VALUE } }],
      sourceStatedCount: null,
      notes: null,
    });

    assert.match(content, /price: not stated/);
  });

  it("is generic — the same rendering serves jobs, products and promotions", () => {
    const content = renderExtraction({
      requestedFields: ["seniority", "location"],
      items: [
        { label: "Backend Engineer", fields: { seniority: "Senior", location: "Remote" } },
        { label: "Designer", fields: { seniority: "Mid", location: "Remote" } },
      ],
      sourceStatedCount: null,
      notes: null,
    });

    assert.match(content, /Total items extracted: 2/);
    assert.match(content, /location — Remote: 2/);
    assert.match(content, /Backend Engineer/);
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

  it("asks for one JSON object and describes its shape", () => {
    assert.match(prompts.systemPrompt, /ONE JSON object and nothing else/);
    assert.match(prompts.systemPrompt, /"requestedFields"/);
    assert.match(prompts.systemPrompt, /"sourceStatedCount"/);
  });

  it("requires the same fields on every item, with an explicit unknown", () => {
    assert.match(prompts.systemPrompt, /EVERY item must carry EVERY one of those fields/);
    assert.ok(prompts.systemPrompt.includes(UNKNOWN_FIELD_VALUE));
  });

  it("tells the model not to report totals, because they are computed here", () => {
    assert.match(prompts.systemPrompt, /Do NOT report totals, counts, or a breakdown of your own/);
    assert.match(prompts.systemPrompt, /never put your own tally there/);
  });

  it("says nothing about truncation for a page that was captured whole", () => {
    assert.ok(!prompts.userPrompt.includes("cut short"));
  });

  it("warns the model when the captured text stops short of the page", () => {
    const truncated = buildExtractionPrompts({
      instructions: INSTRUCTION,
      pageText: `${PAGE}\n${PAGE_TEXT_TRUNCATION_MARKER}`,
      pageTitle: "Business events",
      pageUrl: "https://events.example.com/",
      today: new Date("2026-08-13T09:00:00.000Z"),
    });

    assert.match(truncated.userPrompt, /cut short of the end of the page/);
    assert.match(truncated.userPrompt, /do not try to guess what came after it/);
  });
});

describe("product-page extraction — the repair prompt", () => {
  const repair = buildExtractionRepairPrompt(
    "PAGE TEXT — the only permitted source of facts:\n---\nEnergy Update — free\n---",
    reply([EVENT_A]),
    "Every item must carry every field in requestedFields."
  );

  it("carries the page text again, so the fix is read off the page", () => {
    // A repair asked without the evidence is a model editing its own answer from
    // memory, which is how a missing field gets a plausible value instead of a
    // true one.
    assert.match(repair, /Energy Update — free/);
    assert.match(repair, /the only permitted source of facts/);
  });

  it("names the exact problem and asks for the whole list again", () => {
    assert.match(repair, /Every item must carry every field/);
    assert.match(repair, /Answer again in full/);
  });

  it("still allows the not-found answer, so a repair cannot force an invention", () => {
    assert.ok(repair.includes(NOT_FOUND_MARKER));
  });

  it("is bounded — one repair, because two model calls fit the item budget", () => {
    assert.equal(MAX_EXTRACTION_REPAIR_ATTEMPTS, 1);
  });
});
