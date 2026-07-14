import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  aspectId,
  normalizeAspectFocus,
  isGenericFocus,
  jaccardSimilarity,
  validateAspects,
  selectAspect,
  selectRetryAspect,
  type ContentAspect,
} from "./content-aspect";
import { buildContextFingerprint, extractAspects } from "./aspect-extractor";
import { loadAspectPoolData, allAspectsUsed, buildSnapshotAspectFields } from "./aspect-pool-store";
import { buildPrompts } from "./prompt-builder";
import type { GenerationContext } from "./types";
import type { ILlmProvider, LlmRequest, LlmResponse } from "./types";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeAspect(
  focus: string,
  title = "Title",
  visualConcept = "a visual scene"
): ContentAspect {
  return { id: aspectId(focus), title, focus, visualConcept };
}

function makeSnapshot(
  fingerprint: string,
  pool: ContentAspect[],
  selected: ContentAspect,
  round = 1
): Record<string, unknown> {
  return buildSnapshotAspectFields(fingerprint, pool, selected, round) as unknown as Record<
    string,
    unknown
  >;
}

function makeProvider(responses: string[]): ILlmProvider {
  let i = 0;
  return {
    async generate(_req: LlmRequest): Promise<LlmResponse> {
      const text = responses[Math.min(i++, responses.length - 1)];
      return { text };
    },
  };
}

function aspectsJson(
  aspects: Array<{ title: string; focus: string; visualConcept: string }>
): string {
  return JSON.stringify(aspects);
}

const FEED_ITEMS = [
  {
    id: "item-1",
    title: "How async/await simplifies error handling in Node.js",
    content: "Promises can be complex. Async await makes code readable and maintainable.",
    url: "https://example.com/1",
    publishedAt: null,
  },
  {
    id: "item-2",
    title: "Understanding the event loop",
    content: "The event loop is the heart of Node.js concurrency model.",
    url: "https://example.com/2",
    publishedAt: null,
  },
];

const CTX: GenerationContext = {
  company: { name: "Acme", website: null, automationMode: "semi_automated", defaultLang: "en" },
  brand: null,
  channel: {
    channel: "linkedin",
    postingLanguage: "en",
    imageRequired: false,
    automationModeOverride: null,
    maxTextLength: null,
    includeSourceLink: false,
  },
  feedItems: FEED_ITEMS,
  hasContentSources: true,
  llm: { provider: "groq", model: "llama-3.3-70b-versatile" },
};

// ─── 1. aspectId — deterministic ──────────────────────────────────────────────

describe("aspectId — deterministic hash", () => {
  it("produces the same id for the same focus regardless of casing/whitespace", () => {
    assert.strictEqual(aspectId("async error handling"), aspectId("  Async Error Handling  "));
  });

  it("produces different ids for different focuses", () => {
    assert.notStrictEqual(aspectId("async error handling"), aspectId("event loop concurrency"));
  });

  it("returns an 8-character hex string", () => {
    assert.match(aspectId("some focus text here"), /^[0-9a-f]{8}$/);
  });
});

// ─── 2. isGenericFocus ────────────────────────────────────────────────────────

describe("isGenericFocus — rejects empty or generic focuses", () => {
  it("rejects empty string", () => {
    assert.ok(isGenericFocus(""));
  });

  it("rejects one-word focus", () => {
    assert.ok(isGenericFocus("innovation"));
  });

  it("rejects two-word focus", () => {
    assert.ok(isGenericFocus("tech trends"));
  });

  it("accepts a specific multi-word focus", () => {
    assert.ok(!isGenericFocus("async error handling patterns in production"));
  });

  it("rejects known generic phrases", () => {
    assert.ok(isGenericFocus("overview"));
    assert.ok(isGenericFocus("introduction"));
    assert.ok(isGenericFocus("summary"));
  });
});

// ─── 3. validateAspects ───────────────────────────────────────────────────────

describe("validateAspects — duplicate/similar focus rejection", () => {
  it("rejects aspects with empty fields", () => {
    const result = validateAspects([
      { title: "", focus: "valid focus here", visualConcept: "a scene" },
    ]);
    assert.strictEqual(result.length, 0);
  });

  it("rejects generic focuses", () => {
    const result = validateAspects([{ title: "T", focus: "overview", visualConcept: "a scene" }]);
    assert.strictEqual(result.length, 0);
  });

  it("deduplicates exact normalized focuses within the same batch", () => {
    const raw = [
      { title: "A", focus: "async error handling in node", visualConcept: "a scene" },
      { title: "B", focus: "  Async Error Handling In Node  ", visualConcept: "another scene" },
    ];
    const result = validateAspects(raw);
    assert.strictEqual(result.length, 1);
  });

  it("rejects focuses too similar to existing pool focuses", () => {
    const existing = ["async error handling patterns in node js"];
    const raw = [
      { title: "A", focus: "async error handling in node js", visualConcept: "a scene" },
    ];
    const result = validateAspects(raw, existing);
    assert.strictEqual(result.length, 0);
  });

  it("accepts genuinely distinct focuses", () => {
    const raw = [
      { title: "A", focus: "async error handling in node js", visualConcept: "a scene" },
      { title: "B", focus: "event loop concurrency model explanation", visualConcept: "gears" },
    ];
    const result = validateAspects(raw);
    assert.strictEqual(result.length, 2);
  });

  it("assigns deterministic ids from focus text", () => {
    const raw = [
      { title: "A", focus: "async error handling in node js", visualConcept: "a scene" },
    ];
    const [aspect] = validateAspects(raw);
    assert.strictEqual(aspect.id, aspectId("async error handling in node js"));
  });
});

// ─── 3b. validateAspects — distinct fine-grained aspects ──────────────────────

describe("validateAspects — distinct fine-grained aspects", () => {
  it("rejects a second aspect that differs from the first only by wording", () => {
    // Same underlying point ('shallow calm bays suit families with toddlers'),
    // just reworded — must collapse to a single aspect.
    const raw = [
      {
        title: "Calm bays for toddlers",
        focus: "shallow calm bays let families with toddlers wade safely",
        visualConcept: "a calm shallow turquoise bay with gentle ripples",
      },
      {
        title: "Safe shallow water",
        focus: "families with toddlers can safely wade in the shallow calm bays",
        visualConcept: "toddler-friendly shallow shoreline under blue sky",
      },
    ];
    const result = validateAspects(raw);
    assert.strictEqual(result.length, 1, "wording-only variants must collapse to one aspect");
  });

  it("keeps genuinely distinct fine-grained sub-aspects of the same subject", () => {
    // Both are about Corfu families, but each makes a DIFFERENT concrete point:
    // one about beaches, one about food — distinct facts, so both are kept.
    const raw = [
      {
        title: "Shallow toddler beaches",
        focus: "shallow calm east-coast bays let toddlers wade safely near the shore",
        visualConcept: "a calm shallow turquoise bay with gentle ripples at dawn",
      },
      {
        title: "Family-friendly tavernas",
        focus: "village tavernas offer child portions and highchairs away from crowds",
        visualConcept: "a quiet stone taverna courtyard with wooden tables under vines",
      },
    ];
    const result = validateAspects(raw);
    assert.strictEqual(result.length, 2, "distinct concrete sub-aspects must both survive");
  });

  it("rejects broad/generic focuses in favour of narrow ones", () => {
    const raw = [
      { title: "Great for families", focus: "great for families", visualConcept: "a beach" },
      {
        title: "Shallow toddler bays",
        focus: "shallow calm bays let toddlers wade safely near the shore",
        visualConcept: "a calm shallow turquoise bay with gentle ripples",
      },
    ];
    const result = validateAspects(raw);
    // "great for families" is 3 words but a generic praise theme; the narrow one survives.
    assert.ok(
      result.some((a) => a.focus.includes("shallow")),
      "the narrow, actionable sub-aspect must be kept"
    );
    assert.ok(
      !result.some((a) => a.focus === "great for families"),
      "the broad generic theme must not survive alongside the narrow one"
    );
  });
});

// ─── 4. selectAspect — unused first, then LRU ────────────────────────────────

describe("selectAspect — unused aspects preferred", () => {
  const a1 = makeAspect("async error handling patterns");
  const a2 = makeAspect("event loop concurrency model");
  const a3 = makeAspect("promise chaining best practices");
  const pool = [a1, a2, a3];

  it("returns the first unused aspect when history is empty", () => {
    const selected = selectAspect(pool, []);
    assert.strictEqual(selected.id, a1.id);
  });

  it("skips used aspects and returns the first unused one", () => {
    const selected = selectAspect(pool, [a1.id]);
    assert.strictEqual(selected.id, a2.id);
  });

  it("uses LRU when all aspects have been used once", () => {
    // usedIds most-recent-first: a1 most recent, a3 least recent
    const usedIds = [a1.id, a2.id, a3.id];
    const selected = selectAspect(pool, usedIds);
    assert.strictEqual(selected.id, a3.id); // a3 is at index 2 = deepest = LRU
  });
});

// ─── 5. selectRetryAspect — forces different aspect ──────────────────────────

describe("selectRetryAspect — retry switches aspect", () => {
  const a1 = makeAspect("async error handling patterns");
  const a2 = makeAspect("event loop concurrency model");
  const pool = [a1, a2];

  it("returns a different aspect than the current one", () => {
    const retry = selectRetryAspect(a1.id, pool, []);
    assert.notStrictEqual(retry.id, a1.id);
  });

  it("prefers unused aspects over the current one", () => {
    const retry = selectRetryAspect(a1.id, pool, [a1.id]);
    assert.strictEqual(retry.id, a2.id);
  });

  it("falls back to LRU non-current aspect when all are used", () => {
    // a1 is current; a2 is LRU (at index 1)
    const usedIds = [a1.id, a2.id];
    const retry = selectRetryAspect(a1.id, pool, usedIds);
    assert.strictEqual(retry.id, a2.id);
  });
});

// ─── 6. buildContextFingerprint ───────────────────────────────────────────────

describe("buildContextFingerprint", () => {
  it("returns null when feedItems is empty", () => {
    assert.strictEqual(buildContextFingerprint([]), null);
  });

  it("returns a 12-character hex string for non-empty feedItems", () => {
    const fp = buildContextFingerprint(FEED_ITEMS);
    assert.ok(fp !== null);
    assert.match(fp, /^[0-9a-f]{12}$/);
  });

  it("returns the same fingerprint for the same set of items regardless of order", () => {
    const fp1 = buildContextFingerprint(FEED_ITEMS);
    const fp2 = buildContextFingerprint([...FEED_ITEMS].reverse());
    assert.strictEqual(fp1, fp2);
  });

  it("returns a different fingerprint for a different set of items", () => {
    const fp1 = buildContextFingerprint(FEED_ITEMS);
    const fp2 = buildContextFingerprint([FEED_ITEMS[0]]);
    assert.notStrictEqual(fp1, fp2);
  });
});

// ─── 7. loadAspectPoolData — pool loading from snapshots ─────────────────────

describe("loadAspectPoolData — cold cache miss", () => {
  it("returns null when snapshots array is empty", () => {
    assert.strictEqual(loadAspectPoolData([], "fp-abc"), null);
  });

  it("returns null for legacy snapshots that have no aspectFingerprint (backward compat)", () => {
    const legacySnap: Record<string, unknown> = {
      systemPrompt: "...",
      contentAngle: "Educational",
      topic: "some topic",
    };
    assert.strictEqual(loadAspectPoolData([legacySnap], "fp-abc"), null);
  });

  it("returns null when no snapshot matches the requested fingerprint", () => {
    const a1 = makeAspect("async error handling patterns");
    const snap = makeSnapshot("fp-other", [a1], a1);
    assert.strictEqual(loadAspectPoolData([snap], "fp-abc"), null);
  });
});

describe("loadAspectPoolData — pool reconstruction", () => {
  const a1 = makeAspect("async error handling patterns");
  const a2 = makeAspect("event loop concurrency model");
  const FP = "fp-abc123";

  it("reconstructs pool and usedAspectIds from matching snapshots", () => {
    const snap1 = makeSnapshot(FP, [a1, a2], a1, 1); // most recent: used a1
    const snap2 = makeSnapshot(FP, [a1, a2], a2, 1); // older: used a2
    const poolData = loadAspectPoolData([snap1, snap2], FP);
    assert.ok(poolData !== null);
    assert.strictEqual(poolData.pool.length, 2);
    assert.deepEqual(poolData.usedAspectIds, [a1.id, a2.id]); // most-recent-first
  });

  it("returns the pool from the most recent snapshot", () => {
    const snap = makeSnapshot(FP, [a1, a2], a1);
    const poolData = loadAspectPoolData([snap], FP);
    assert.ok(poolData !== null);
    assert.strictEqual(poolData.pool.length, 2);
  });

  it("ignores snapshots for a different fingerprint", () => {
    const snapMatch = makeSnapshot(FP, [a1], a1);
    const snapOther = makeSnapshot("fp-other", [a2], a2);
    const poolData = loadAspectPoolData([snapMatch, snapOther], FP);
    assert.ok(poolData !== null);
    assert.strictEqual(poolData.usedAspectIds.length, 1);
  });
});

// ─── 8. allAspectsUsed ────────────────────────────────────────────────────────

describe("allAspectsUsed", () => {
  const a1 = makeAspect("async error handling patterns");
  const a2 = makeAspect("event loop concurrency model");

  it("returns false when some aspects are unused", () => {
    assert.ok(!allAspectsUsed([a1, a2], [a1.id]));
  });

  it("returns true when every aspect has been used", () => {
    assert.ok(allAspectsUsed([a1, a2], [a1.id, a2.id]));
  });

  it("returns false for an empty pool", () => {
    assert.ok(!allAspectsUsed([], []));
  });
});

// ─── 9. Progressive extraction — exclusions + append ─────────────────────────

describe("extractAspects — exclusions passed to later round", async () => {
  it("calls provider with exclusions when existingFocuses is non-empty", async () => {
    let capturedPrompt = "";
    const provider: ILlmProvider = {
      async generate(req: LlmRequest): Promise<LlmResponse> {
        capturedPrompt = req.userPrompt;
        return { text: "[]" }; // return empty — we're testing the prompt, not the output
      },
    };

    await extractAspects(provider, FEED_ITEMS, ["async error handling patterns"]);
    assert.ok(
      capturedPrompt.includes("async error handling patterns"),
      "extraction prompt should include excluded focus"
    );
  });
});

describe("extractAspects — new aspects appended not replacing", async () => {
  it("returns only genuinely new aspects (caller appends to pool)", async () => {
    const existingFocus = "async error handling patterns";
    // Provider returns one aspect that matches excluded focus and one that is new
    const rawAspects = [
      { title: "Existing", focus: existingFocus, visualConcept: "a scene" }, // same as exclusion
      {
        title: "New",
        focus: "event loop concurrency model detailed",
        visualConcept: "gears rotating",
      },
    ];
    const provider = makeProvider([aspectsJson(rawAspects)]);

    const result = await extractAspects(provider, FEED_ITEMS, [existingFocus]);
    // Should only contain the genuinely new one
    assert.ok(result.every((a) => a.focus !== existingFocus));
    assert.ok(result.length <= 1);
  });
});

// ─── 10. No-new-aspects fallback ─────────────────────────────────────────────
// Tested in resolve-generation-aspect: when extractAspects returns [],
// the pool stays as poolData.pool (no replacement). We test allAspectsUsed
// and selectAspect LRU as the underlying mechanism here.

describe("no-new-aspects fallback — LRU reuse of existing pool", () => {
  const a1 = makeAspect("async error handling patterns");
  const a2 = makeAspect("event loop concurrency model");
  const pool = [a1, a2];

  it("LRU selects the least recently used when all aspects have been used", () => {
    // Simulate: a2 was used first (index 1), a1 was used more recently (index 0)
    const usedIds = [a1.id, a2.id]; // most-recent-first
    const selected = selectAspect(pool, usedIds);
    assert.strictEqual(selected.id, a2.id); // a2 is at deeper index → LRU
  });
});

// ─── 11. visualConcept in imagePrompt instruction ─────────────────────────────

describe("prompt-builder — visualConcept appears in imagePrompt instruction", () => {
  it("includes aspect focus as mandatory constraint in userPrompt", () => {
    const aspect = makeAspect(
      "async error handling reduces crashes",
      "Error Handling",
      "close-up of a cracked screen showing a stack trace error message on a dark background"
    );
    const { userPrompt } = buildPrompts(CTX, "en", [], { aspect });
    assert.ok(userPrompt.includes(aspect.focus), "userPrompt must contain the aspect focus");
  });

  it("includes aspect visualConcept as imagePrompt anchor in userPrompt", () => {
    const aspect = makeAspect(
      "async error handling reduces crashes",
      "Error Handling",
      "close-up of a cracked screen showing a stack trace error message on a dark background"
    );
    const { userPrompt } = buildPrompts(CTX, "en", [], { aspect });
    assert.ok(
      userPrompt.includes(aspect.visualConcept),
      "userPrompt must contain the aspect visualConcept"
    );
  });

  it("does not include aspect sections when no aspect is provided", () => {
    const { userPrompt } = buildPrompts(CTX, "en", [], {});
    assert.ok(
      !userPrompt.includes("Content aspect"),
      "userPrompt must not include aspect section when no aspect is passed"
    );
  });
});

// ─── 12. extractAspects — first extraction on cache miss ─────────────────────

describe("extractAspects — first extraction on cache miss", async () => {
  it("extracts valid aspects and assigns deterministic ids", async () => {
    const rawAspects = [
      {
        title: "Error Handling Patterns",
        focus: "async error handling reduces production crashes significantly",
        visualConcept: "close-up of a cracked screen showing a stack trace error",
      },
      {
        title: "Event Loop Deep Dive",
        focus: "understanding event loop enables better concurrency decisions",
        visualConcept: "circular arrows representing task queue flow on black background",
      },
    ];
    const provider = makeProvider([aspectsJson(rawAspects)]);
    const aspects = await extractAspects(provider, FEED_ITEMS, []);

    assert.ok(aspects.length > 0, "should extract at least one aspect");
    for (const aspect of aspects) {
      assert.match(aspect.id, /^[0-9a-f]{8}$/, "each aspect id must be 8 hex chars");
      assert.ok(aspect.focus.length > 0, "focus must be non-empty");
      assert.ok(aspect.visualConcept.length > 0, "visualConcept must be non-empty");
    }
  });

  it("returns empty array when provider returns invalid JSON", async () => {
    const provider = makeProvider(["not json at all"]);
    const aspects = await extractAspects(provider, FEED_ITEMS, []);
    assert.strictEqual(aspects.length, 0);
  });

  it("returns empty array when provider returns empty array", async () => {
    const provider = makeProvider(["[]"]);
    const aspects = await extractAspects(provider, FEED_ITEMS, []);
    assert.strictEqual(aspects.length, 0);
  });
});

// ─── 13. buildSnapshotAspectFields — round-trip ───────────────────────────────

describe("buildSnapshotAspectFields — stored fields are reconstructable", () => {
  it("round-trips through loadAspectPoolData correctly", () => {
    const a1 = makeAspect("async error handling reduces production crashes");
    const FP = buildContextFingerprint(FEED_ITEMS)!;
    const fields = buildSnapshotAspectFields(FP, [a1], a1, 1) as unknown as Record<string, unknown>;

    const poolData = loadAspectPoolData([fields], FP);
    assert.ok(poolData !== null);
    assert.strictEqual(poolData.pool.length, 1);
    assert.strictEqual(poolData.usedAspectIds[0], a1.id);
    assert.strictEqual(poolData.extractionRound, 1);
  });
});

// ─── 14. normalizeAspectFocus ─────────────────────────────────────────────────

describe("normalizeAspectFocus", () => {
  it("lowercases and trims whitespace", () => {
    assert.strictEqual(normalizeAspectFocus("  Async Error Handling  "), "async error handling");
  });

  it("collapses internal whitespace", () => {
    assert.strictEqual(normalizeAspectFocus("async  error   handling"), "async error handling");
  });
});

// ─── 15. jaccardSimilarity ────────────────────────────────────────────────────

describe("jaccardSimilarity", () => {
  it("returns 1 for identical strings", () => {
    assert.strictEqual(jaccardSimilarity("async error handling", "async error handling"), 1);
  });

  it("returns 0 for completely disjoint strings", () => {
    assert.strictEqual(jaccardSimilarity("foo bar baz", "qux quux corge"), 0);
  });

  it("returns a value in [0, 1) for partially overlapping strings", () => {
    const sim = jaccardSimilarity("async error handling", "async exception handling");
    assert.ok(sim > 0 && sim < 1, `expected sim in (0,1), got ${sim}`);
  });
});
