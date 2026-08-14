import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  extractProductPage,
  readStoredProductPage,
  type ExtractableItem,
  type ExtractProductPageDb,
} from "./extract-product-page.service";
import { NOT_FOUND_MARKER } from "@/lib/ai/product-page-extraction";
import { PAGE_TEXT_TRUNCATION_MARKER } from "@/lib/integrations/product-page/scraper";
import type { ILlmProvider, LlmRequest, LlmResponse } from "@/lib/ai/types";

// ─── Fakes ────────────────────────────────────────────────────────────────────

interface Write {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
}

let updates: Write[] = [];
let updateManyCalls: Write[] = [];
/** Rows the conditional claim is allowed to match. Set to 0 to simulate a loser. */
let claimCount = 1;

const db: ExtractProductPageDb = {
  feedItem: {
    update: async (args) => {
      updates.push({ where: args.where as Record<string, unknown>, data: args.data });
      return {};
    },
    updateMany: async (args) => {
      updateManyCalls.push(args);
      return { count: claimCount };
    },
  },
};

/**
 * A provider that answers with the next reply in the list, repeating the last one
 * once the list is spent. A list of two is how a repair is exercised: the first
 * reply is rejected, the second is what the repair produced.
 */
function provider(...replies: (string | (() => never))[]): {
  instance: ILlmProvider;
  requests: LlmRequest[];
} {
  const requests: LlmRequest[] = [];
  return {
    requests,
    instance: {
      async generate(req: LlmRequest): Promise<LlmResponse> {
        const reply = replies[Math.min(requests.length, replies.length - 1)];
        requests.push(req);
        if (typeof reply === "function") reply();
        return { text: reply as string };
      },
    },
  };
}

function resolveTo(instance: ILlmProvider) {
  return async () => ({ ok: true as const, instance, provider: "TEXT_WORKER", model: "qwen3:8b" });
}

const PAGE_TEXT = "Energy Update — webinar, 18.08.2026, free\nHR Masterclass — 19.08.2026, 50 BGN";
const INSTRUCTION = "Extract every event next week with its type, date and price.";

/** A complete, well-formed reply for the two events on PAGE_TEXT. */
const GOOD_REPLY = JSON.stringify({
  requestedFields: ["type", "date", "price"],
  items: [
    { label: "Energy Update", fields: { type: "Webinar", date: "18.08.2026", price: "Free" } },
    {
      label: "HR Masterclass",
      fields: { type: "Masterclass", date: "19.08.2026", price: "50 BGN" },
    },
  ],
  sourceStatedCount: 2,
  notes: null,
});

/** The same, with the second event stripped of two of its fields. */
const SHORT_FIELDS_REPLY = JSON.stringify({
  requestedFields: ["type", "date", "price"],
  items: [
    { label: "Energy Update", fields: { type: "Webinar", date: "18.08.2026", price: "Free" } },
    { label: "HR Masterclass", fields: { type: "Masterclass" } },
  ],
  sourceStatedCount: null,
  notes: null,
});

function item(overrides: Partial<ExtractableItem> = {}): ExtractableItem {
  return {
    id: "item-1",
    title: "Business events",
    content: JSON.stringify({
      title: "Business events",
      description: "A catalogue.",
      instructions: INSTRUCTION,
      pageText: PAGE_TEXT,
    }),
    url: "https://events.example.com/?week=current",
    extractionStatus: "pending",
    extractionHash: "hash-1",
    extractionAttemptCount: 0,
    ...overrides,
  };
}

const lastWrite = () => updates.at(-1)!;

beforeEach(() => {
  updates = [];
  updateManyCalls = [];
  claimCount = 1;
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("extractProductPage — reading the stored raw page", () => {
  it("pulls the instruction, page text and title out of the ingested JSON", () => {
    const stored = readStoredProductPage(item().content);

    assert.equal(stored.instructions, INSTRUCTION);
    assert.equal(stored.pageText, PAGE_TEXT);
    assert.equal(stored.title, "Business events");
  });

  it("returns nulls for content that is not the product-page JSON", () => {
    assert.deepEqual(readStoredProductPage("just some article text"), {
      instructions: null,
      pageText: null,
      title: null,
    });
    assert.deepEqual(readStoredProductPage(null), {
      instructions: null,
      pageText: null,
      title: null,
    });
  });
});

describe("extractProductPage — a successful extraction", () => {
  it("persists the extracted facts and marks the item completed", async () => {
    const { instance } = provider(GOOD_REPLY);

    const outcome = await extractProductPage(item(), { db, resolveProvider: resolveTo(instance) });

    assert.equal(outcome.status, "extracted");
    assert.equal(outcome.status === "extracted" ? outcome.itemCount : 0, 2);
    assert.equal(lastWrite().data.extractionStatus, "completed");
    assert.equal(lastWrite().data.extractionError, null);
  });

  it("stores the rendered facts, not the model's raw JSON", async () => {
    const { instance } = provider(GOOD_REPLY);

    await extractProductPage(item(), { db, resolveProvider: resolveTo(instance) });

    const stored = String(lastWrite().data.extractedContent);
    assert.ok(
      !stored.includes('"requestedFields"'),
      "the stored text is read by a writer, not a parser"
    );
    assert.match(stored, /^Total items extracted: 2$/m);
  });

  it("counts the items itself rather than quoting the model's total", async () => {
    // The model claims five; the list holds two. The stored count is two.
    const { instance } = provider(
      JSON.stringify({
        requestedFields: ["type"],
        items: [
          { label: "Energy Update", fields: { type: "Webinar" } },
          { label: "HR Masterclass", fields: { type: "Masterclass" } },
        ],
        total: 5,
        totalEvents: 5,
        sourceStatedCount: null,
      })
    );

    await extractProductPage(item(), { db, resolveProvider: resolveTo(instance) });

    const stored = String(lastWrite().data.extractedContent);
    assert.match(stored, /Total items extracted: 2/);
    assert.ok(!stored.includes("5"), "a claimed total must not survive into the stored facts");
  });

  it("never writes over the raw page it extracted from", async () => {
    // `content` is the input the result was derived from. Overwriting it would
    // make the next run extract from an extraction.
    const { instance } = provider(GOOD_REPLY);

    await extractProductPage(item(), { db, resolveProvider: resolveTo(instance) });

    for (const write of updates) {
      assert.ok(!("content" in write.data), "content must never be written by extraction");
      assert.ok(!("title" in write.data));
    }
  });

  it("preserves every item the page listed — nothing is summarised away here", async () => {
    const { instance } = provider(GOOD_REPLY);

    await extractProductPage(item(), { db, resolveProvider: resolveTo(instance) });

    const stored = String(lastWrite().data.extractedContent);
    assert.ok(stored.includes("Energy Update"));
    assert.ok(stored.includes("HR Masterclass"));
    assert.ok(stored.includes("50 BGN"));
  });

  it("asks the model once, deterministically, with the page and the instruction", async () => {
    const { instance, requests } = provider(GOOD_REPLY);

    await extractProductPage(item(), { db, resolveProvider: resolveTo(instance) });

    assert.equal(requests.length, 1, "a usable reply costs exactly one call");
    assert.equal(requests[0].temperature, 0, "fact-gathering must not vary between runs");
    assert.ok(requests[0].userPrompt.includes(PAGE_TEXT));
    assert.ok(requests[0].userPrompt.includes(INSTRUCTION));
  });

  it("claims the item before calling out, and counts the attempt once", async () => {
    const { instance } = provider(GOOD_REPLY);

    await extractProductPage(item(), { db, resolveProvider: resolveTo(instance) });

    assert.equal(updateManyCalls.length, 1);
    assert.equal(updateManyCalls[0].data.extractionStatus, "extracting");
    assert.equal(updateManyCalls[0].data.extractionAttemptCount, 1);
  });
});

describe("extractProductPage — an incomplete reply is repaired, then rejected", () => {
  it("retries with feedback when an item is missing a requested field", async () => {
    const { instance, requests } = provider(SHORT_FIELDS_REPLY, GOOD_REPLY);

    const outcome = await extractProductPage(item(), { db, resolveProvider: resolveTo(instance) });

    assert.equal(outcome.status, "extracted");
    assert.equal(requests.length, 2, "one repair call");
    assert.match(requests[1].userPrompt, /HR Masterclass/);
    assert.match(requests[1].userPrompt, /date, price/);
    assert.ok(requests[1].userPrompt.includes(PAGE_TEXT), "the repair re-reads the page");
  });

  it("retries when the model answered in prose instead of the agreed shape", async () => {
    const { instance, requests } = provider("There are two events this week.", GOOD_REPLY);

    const outcome = await extractProductPage(item(), { db, resolveProvider: resolveTo(instance) });

    assert.equal(outcome.status, "extracted");
    assert.equal(requests.length, 2);
    assert.match(requests[1].userPrompt, /was not JSON/);
  });

  it("retries when the page's own count is higher than the list returned", async () => {
    const short = JSON.stringify({
      requestedFields: ["type"],
      items: [{ label: "Energy Update", fields: { type: "Webinar" } }],
      sourceStatedCount: 5,
    });
    const { instance, requests } = provider(short, GOOD_REPLY);

    const outcome = await extractProductPage(item(), { db, resolveProvider: resolveTo(instance) });

    assert.equal(outcome.status, "extracted");
    assert.match(requests[1].userPrompt, /says there are 5 items, and you returned 1/);
  });

  it("stops after the bounded repair and stores nothing", async () => {
    // The whole point: an extraction that cannot be shown to be complete must not
    // become the authoritative fact set three channels then write posts from.
    const { instance, requests } = provider(SHORT_FIELDS_REPLY);

    const outcome = await extractProductPage(item(), { db, resolveProvider: resolveTo(instance) });

    assert.equal(outcome.status, "failed");
    assert.equal(requests.length, 2, "one attempt plus one repair, and no more");
    assert.equal(updates.length, 0, "no extractedContent is written");
    assert.match(
      String(updateManyCalls.at(-1)!.data.extractionError),
      /incomplete and was not stored/
    );
    assert.equal(updateManyCalls.at(-1)!.data.extractionStatus, "failed");
  });

  it("keeps the item retryable — an incomplete run is a failure, not a settled answer", async () => {
    // `failed` is what the drain re-selects, bounded by the attempt count. A
    // status of `completed` or `not_found` would settle it with a wrong answer.
    const { instance } = provider(SHORT_FIELDS_REPLY);

    await extractProductPage(item(), { db, resolveProvider: resolveTo(instance) });

    assert.equal(updateManyCalls.at(-1)!.data.extractionStatus, "failed");
    assert.equal(updateManyCalls.at(-1)!.where.extractionStatus, "extracting");
  });

  it("honours a repair budget of zero", async () => {
    const { instance, requests } = provider(SHORT_FIELDS_REPLY, GOOD_REPLY);

    const outcome = await extractProductPage(item(), {
      db,
      resolveProvider: resolveTo(instance),
      maxRepairAttempts: 0,
    });

    assert.equal(outcome.status, "failed");
    assert.equal(requests.length, 1);
  });
});

describe("extractProductPage — the page does not contain what was asked for", () => {
  it("records not_found with its reason instead of a fabricated list", async () => {
    // The live case: a `week=current` page against a "next week" instruction.
    const { instance } = provider(
      `${NOT_FOUND_MARKER}: The page lists only events for the current week.`
    );

    const outcome = await extractProductPage(item(), { db, resolveProvider: resolveTo(instance) });

    assert.equal(outcome.status, "not_found");
    assert.equal(lastWrite().data.extractionStatus, "not_found");
    assert.equal(
      lastWrite().data.extractedContent,
      null,
      "nothing may be stored as extracted facts"
    );
    assert.match(String(lastWrite().data.extractionError), /only events for the current week/);
  });

  it("never repairs a not-found answer into a list", async () => {
    // A repair here would be an instruction to try harder at finding something
    // that is not there, which is exactly how an invented list gets written.
    const { instance, requests } = provider(`${NOT_FOUND_MARKER}: nothing next week.`, GOOD_REPLY);

    const outcome = await extractProductPage(item(), { db, resolveProvider: resolveTo(instance) });

    assert.equal(outcome.status, "not_found");
    assert.equal(requests.length, 1);
  });

  it("does not confuse an empty page with an unusable reply", async () => {
    // Both produce no facts; only one is a settled answer. `not_found` stops, a
    // rejected reply retries.
    const empty = await extractProductPage(item(), {
      db,
      resolveProvider: resolveTo(provider(`${NOT_FOUND_MARKER}: none.`).instance),
    });
    assert.equal(empty.status, "not_found");
    assert.equal(lastWrite().data.extractionStatus, "not_found");

    updates = [];
    updateManyCalls = [];
    const unusable = await extractProductPage(item(), {
      db,
      resolveProvider: resolveTo(provider("nothing in particular").instance),
    });
    assert.equal(unusable.status, "failed");
    assert.equal(updateManyCalls.at(-1)!.data.extractionStatus, "failed");
  });

  it("does not call the model at all when the scrape produced no page text", async () => {
    const { instance, requests } = provider("should not be reached");

    const outcome = await extractProductPage(
      item({ content: JSON.stringify({ instructions: INSTRUCTION, pageText: null }) }),
      { db, resolveProvider: resolveTo(instance) }
    );

    assert.equal(outcome.status, "skipped");
    assert.equal(requests.length, 0);
    assert.equal(lastWrite().data.extractionStatus, "not_found");
  });
});

describe("extractProductPage — a page text the scrape had to cut short", () => {
  const truncatedItem = () =>
    item({
      content: JSON.stringify({
        instructions: INSTRUCTION,
        pageText: `${PAGE_TEXT}\n${PAGE_TEXT_TRUNCATION_MARKER}`,
      }),
    });

  it("tells the model the text stops short of the page", async () => {
    const { instance, requests } = provider(GOOD_REPLY);

    await extractProductPage(truncatedItem(), { db, resolveProvider: resolveTo(instance) });

    assert.match(requests[0].userPrompt, /cut short of the end of the page/);
  });

  it("does not chase a shortfall the scrape caused, which no retry could close", async () => {
    const short = JSON.stringify({
      requestedFields: ["type"],
      items: [{ label: "Energy Update", fields: { type: "Webinar" } }],
      sourceStatedCount: 30,
    });
    const { instance, requests } = provider(short);

    const outcome = await extractProductPage(truncatedItem(), {
      db,
      resolveProvider: resolveTo(instance),
    });

    assert.equal(outcome.status, "extracted");
    assert.equal(requests.length, 1, "no repair is spent on a gap the page text has");
  });
});

describe("extractProductPage — failure handling", () => {
  it("records a provider failure without throwing, so the drain continues", async () => {
    const { instance } = provider(() => {
      throw new Error("Text worker unreachable: fetch failed (ECONNREFUSED)");
    });

    const outcome = await extractProductPage(item(), { db, resolveProvider: resolveTo(instance) });

    assert.equal(outcome.status, "failed");
    const guarded = updateManyCalls.at(-1)!;
    assert.equal(
      guarded.where.extractionStatus,
      "extracting",
      "the failure write is claim-guarded"
    );
    assert.equal(guarded.data.extractionStatus, "failed");
  });

  it("does not repair a transport failure — nothing about the reply was wrong", async () => {
    const { instance, requests } = provider(() => {
      throw new Error("Text worker unreachable");
    });

    await extractProductPage(item(), { db, resolveProvider: resolveTo(instance) });

    assert.equal(requests.length, 1);
  });

  it("stops after the attempt budget rather than re-asking forever", async () => {
    const { instance, requests } = provider(GOOD_REPLY);

    const outcome = await extractProductPage(item({ extractionAttemptCount: 3 }), {
      db,
      resolveProvider: resolveTo(instance),
    });

    assert.deepEqual(outcome, { status: "skipped", reason: "max_attempts" });
    assert.equal(requests.length, 0);
  });

  it("skips without calling the model when another run holds the claim", async () => {
    claimCount = 0;
    const { instance, requests } = provider(GOOD_REPLY);

    const outcome = await extractProductPage(item(), { db, resolveProvider: resolveTo(instance) });

    assert.deepEqual(outcome, { status: "skipped", reason: "claimed" });
    assert.equal(requests.length, 0);
  });

  it("reports a missing provider without burning an attempt", async () => {
    const outcome = await extractProductPage(item(), {
      db,
      resolveProvider: async () => ({ ok: false as const }),
    });

    assert.deepEqual(outcome, { status: "no_provider" });
    assert.equal(updateManyCalls.length, 0, "nothing is claimed and no attempt is counted");
  });

  it("times out an item rather than letting it hold the drain open", async () => {
    const instance: ILlmProvider = {
      generate: () => new Promise<LlmResponse>(() => {}),
    };

    const outcome = await extractProductPage(item(), {
      db,
      resolveProvider: resolveTo(instance),
      attemptTimeoutMs: 20,
      itemTimeoutMs: 40,
    });

    assert.equal(outcome.status, "failed");
    assert.match(outcome.status === "failed" ? outcome.error : "", /exceeded its/);
  });
});
