import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  extractProductPage,
  readStoredProductPage,
  type ExtractableItem,
  type ExtractProductPageDb,
} from "./extract-product-page.service";
import { NOT_FOUND_MARKER } from "@/lib/ai/product-page-extraction";
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

function provider(reply: string | (() => never)): {
  instance: ILlmProvider;
  requests: LlmRequest[];
} {
  const requests: LlmRequest[] = [];
  return {
    requests,
    instance: {
      async generate(req: LlmRequest): Promise<LlmResponse> {
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
  const RESULT = [
    "Next week: 17–23 August 2026",
    "Total events: 2",
    "1. Energy Update — Webinar — 18.08.2026 — Online — Free",
    "2. HR Masterclass — Masterclass — 19.08.2026 — In person — Paid, 50 BGN",
  ].join("\n");

  it("persists the extracted facts and marks the item completed", async () => {
    const { instance } = provider(RESULT);

    const outcome = await extractProductPage(item(), { db, resolveProvider: resolveTo(instance) });

    assert.equal(outcome.status, "extracted");
    const write = updates.at(-1)!;
    assert.equal(write.data.extractedContent, RESULT);
    assert.equal(write.data.extractionStatus, "completed");
    assert.equal(write.data.extractionError, null);
  });

  it("never writes over the raw page it extracted from", async () => {
    // `content` is the input the result was derived from. Overwriting it would
    // make the next run extract from an extraction.
    const { instance } = provider(RESULT);

    await extractProductPage(item(), { db, resolveProvider: resolveTo(instance) });

    for (const write of updates) {
      assert.ok(!("content" in write.data), "content must never be written by extraction");
      assert.ok(!("title" in write.data));
    }
  });

  it("preserves every item the page listed — nothing is summarised away here", async () => {
    const { instance } = provider(RESULT);

    await extractProductPage(item(), { db, resolveProvider: resolveTo(instance) });

    const stored = String(updates.at(-1)!.data.extractedContent);
    assert.ok(stored.includes("Energy Update"));
    assert.ok(stored.includes("HR Masterclass"));
    assert.ok(stored.includes("50 BGN"));
  });

  it("asks the model deterministically, with the page and the instruction", async () => {
    const { instance, requests } = provider(RESULT);

    await extractProductPage(item(), { db, resolveProvider: resolveTo(instance) });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].temperature, 0, "fact-gathering must not vary between runs");
    assert.ok(requests[0].userPrompt.includes(PAGE_TEXT));
    assert.ok(requests[0].userPrompt.includes(INSTRUCTION));
  });

  it("claims the item before calling out, and counts the attempt once", async () => {
    const { instance } = provider(RESULT);

    await extractProductPage(item(), { db, resolveProvider: resolveTo(instance) });

    assert.equal(updateManyCalls.length, 1);
    assert.equal(updateManyCalls[0].data.extractionStatus, "extracting");
    assert.equal(updateManyCalls[0].data.extractionAttemptCount, 1);
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
    const write = updates.at(-1)!;
    assert.equal(write.data.extractionStatus, "not_found");
    assert.equal(write.data.extractedContent, null, "nothing may be stored as extracted facts");
    assert.match(String(write.data.extractionError), /only events for the current week/);
  });

  it("does not call the model at all when the scrape produced no page text", async () => {
    const { instance, requests } = provider("should not be reached");

    const outcome = await extractProductPage(
      item({ content: JSON.stringify({ instructions: INSTRUCTION, pageText: null }) }),
      { db, resolveProvider: resolveTo(instance) }
    );

    assert.equal(outcome.status, "skipped");
    assert.equal(requests.length, 0);
    assert.equal(updates.at(-1)!.data.extractionStatus, "not_found");
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

  it("stops after the attempt budget rather than re-asking forever", async () => {
    const { instance, requests } = provider("x");

    const outcome = await extractProductPage(item({ extractionAttemptCount: 3 }), {
      db,
      resolveProvider: resolveTo(instance),
    });

    assert.deepEqual(outcome, { status: "skipped", reason: "max_attempts" });
    assert.equal(requests.length, 0);
  });

  it("skips without calling the model when another run holds the claim", async () => {
    claimCount = 0;
    const { instance, requests } = provider("x");

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
