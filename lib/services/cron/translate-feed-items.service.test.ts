import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { translateFeedItems, type TranslateFeedItemsDeps } from "./translate-feed-items.service";
import type { TranslateFeedItemOutcome } from "@/lib/services/ai/translate-feed-item.service";
import { TRANSLATION_BATCH_SIZE } from "@/lib/ai/feed-item-translation";

interface Candidate {
  id: string;
  title: string | null;
  content: string | null;
  translationStatus: string | null;
  translationHash: string | null;
  translationAttemptCount: number;
  source: { type: string; config: unknown };
}

const RSS_TRANSLATED = { type: "rss", config: { translateEnabled: true } };

function makeCandidate(
  id: string,
  source: { type: string; config: unknown } = RSS_TRANSLATED
): Candidate {
  return {
    id,
    title: `Title ${id}`,
    content: `Content ${id}`,
    translationStatus: "pending",
    translationHash: null,
    translationAttemptCount: 0,
    source,
  };
}

/** Captures the (item, targetLang) pairs the batch dispatched. */
function makeDeps(
  candidates: Candidate[],
  outcome: (item: Candidate) => TranslateFeedItemOutcome = () => ({
    status: "translated",
    provider: "GROQ",
    model: "m",
  }),
  companyLang = "bg"
): TranslateFeedItemsDeps & { calls: Array<{ id: string; lang: string }>; limitSeen: number[] } {
  const calls: Array<{ id: string; lang: string }> = [];
  const limitSeen: number[] = [];
  return {
    calls,
    limitSeen,
    findCandidates: async (_companyId, limit) => {
      limitSeen.push(limit);
      return candidates.slice(0, limit);
    },
    loadCompanyLang: async () => companyLang,
    translate: (async (item: Candidate, lang: string) => {
      calls.push({ id: item.id, lang });
      return outcome(item);
    }) as unknown as TranslateFeedItemsDeps["translate"],
  };
}

describe("translateFeedItems", () => {
  it("translates every eligible candidate and summarises the run", async () => {
    const deps = makeDeps([makeCandidate("a"), makeCandidate("b")]);
    const summary = await translateFeedItems({ companyId: "c1" }, deps);

    assert.deepEqual(summary, { scanned: 2, translated: 2, failed: 0, skipped: 0 });
    assert.deepEqual(
      deps.calls.map((c) => c.id),
      ["a", "b"]
    );
  });

  it("passes the company content language as the default target", async () => {
    const deps = makeDeps([makeCandidate("a")], undefined, "bg");
    await translateFeedItems({ companyId: "c1" }, deps);
    assert.equal(deps.calls[0].lang, "bg");
  });

  it("honours a source-level target language over the company default", async () => {
    const deps = makeDeps(
      [
        makeCandidate("a", {
          type: "rss",
          config: { translateEnabled: true, translateToLanguage: "en" },
        }),
      ],
      undefined,
      "bg"
    );
    await translateFeedItems({ companyId: "c1" }, deps);
    assert.equal(deps.calls[0].lang, "en");
  });

  it("skips items whose source has translation disabled", async () => {
    const deps = makeDeps([
      makeCandidate("off", { type: "rss", config: { translateEnabled: false } }),
      makeCandidate("on"),
    ]);
    const summary = await translateFeedItems({ companyId: "c1" }, deps);

    assert.deepEqual(
      deps.calls.map((c) => c.id),
      ["on"],
      "a disabled source must not reach the LLM"
    );
    assert.equal(summary.skipped, 1);
    assert.equal(summary.translated, 1);
  });

  it("counts failures without aborting the batch", async () => {
    const deps = makeDeps([makeCandidate("a"), makeCandidate("b"), makeCandidate("c")], (item) =>
      item.id === "b"
        ? { status: "failed", error: "boom", nextRetryAt: new Date() }
        : { status: "translated", provider: "GROQ", model: "m" }
    );
    const summary = await translateFeedItems({ companyId: "c1" }, deps);

    assert.equal(summary.translated, 2);
    assert.equal(summary.failed, 1);
    assert.equal(deps.calls.length, 3, "a failure must not stop later items");
  });

  it("enforces the batch size", async () => {
    const many = Array.from({ length: 25 }, (_, i) => makeCandidate(`item-${i}`));
    const deps = makeDeps(many);
    await translateFeedItems({ companyId: "c1" }, deps);

    assert.equal(deps.limitSeen[0], TRANSLATION_BATCH_SIZE);
    assert.equal(deps.calls.length, TRANSLATION_BATCH_SIZE);
  });

  it("respects an explicit limit below the default", async () => {
    const deps = makeDeps(Array.from({ length: 10 }, (_, i) => makeCandidate(`item-${i}`)));
    await translateFeedItems({ companyId: "c1", limit: 3 }, deps);
    assert.equal(deps.calls.length, 3);
  });

  it("stops the run when no provider is configured", async () => {
    const deps = makeDeps([makeCandidate("a"), makeCandidate("b")], () => ({
      status: "no_provider",
    }));
    const summary = await translateFeedItems({ companyId: "c1" }, deps);

    assert.equal(summary.reason, "no_provider");
    assert.equal(deps.calls.length, 1, "must not keep trying once the provider is known missing");
    assert.equal(summary.translated, 0);
  });

  it("does nothing when there is no backlog", async () => {
    const deps = makeDeps([]);
    const summary = await translateFeedItems({ companyId: "c1" }, deps);
    assert.deepEqual(summary, { scanned: 0, translated: 0, failed: 0, skipped: 0 });
  });

  it("stops between items when shouldStop signals the deadline", async () => {
    const deps = makeDeps([makeCandidate("a"), makeCandidate("b"), makeCandidate("c")]);
    // Deadline reached after the first translation: the loop checks before each item.
    const summary = await translateFeedItems(
      { companyId: "c1", shouldStop: () => deps.calls.length >= 1 },
      deps
    );

    assert.equal(deps.calls.length, 1, "must not translate past the deadline");
    assert.equal(summary.translated, 1);
    assert.deepEqual(
      deps.calls.map((c) => c.id),
      ["a"]
    );
  });
});
