import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { translateFeedItems, type TranslateFeedItemsDeps } from "./translate-feed-items.service";
import type { TranslateFeedItemOutcome } from "@/lib/services/ai/translate-feed-item.service";
import {
  MIN_TRANSLATION_ITEM_BUDGET_MS,
  TRANSLATION_BATCH_SIZE,
  TRANSLATION_ITEM_TIMEOUT_MS,
} from "@/lib/ai/feed-item-translation";

interface Candidate {
  id: string;
  title: string | null;
  content: string | null;
  url: string;
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
    url: `https://example.com/${id}`,
    translationStatus: "pending",
    translationHash: null,
    translationAttemptCount: 0,
    source,
  };
}

/** One dispatch as the batch made it: which item, in which language, on what budget. */
interface DispatchedCall {
  id: string;
  lang: string;
  itemTimeoutMs?: number;
}

/** Captures the calls the batch dispatched. */
function makeDeps(
  candidates: Candidate[],
  outcome: (item: Candidate) => TranslateFeedItemOutcome = () => ({
    status: "translated",
    provider: "GROQ",
    model: "m",
    mode: "full",
  }),
  companyLang = "bg"
): TranslateFeedItemsDeps & { calls: DispatchedCall[]; limitSeen: number[] } {
  const calls: DispatchedCall[] = [];
  const limitSeen: number[] = [];
  return {
    calls,
    limitSeen,
    findCandidates: async (_companyId, limit) => {
      limitSeen.push(limit);
      return candidates.slice(0, limit);
    },
    loadCompanyLang: async () => companyLang,
    translate: (async (item: Candidate, lang: string, deps?: { itemTimeoutMs?: number }) => {
      calls.push({ id: item.id, lang, itemTimeoutMs: deps?.itemTimeoutMs });
      return outcome(item);
    }) as unknown as TranslateFeedItemsDeps["translate"],
  };
}

describe("translateFeedItems", () => {
  it("translates every eligible candidate and summarises the run", async () => {
    const deps = makeDeps([makeCandidate("a"), makeCandidate("b")]);
    const summary = await translateFeedItems({ companyId: "c1" }, deps);

    assert.deepEqual(summary, { scanned: 2, translated: 2, failed: 0, skipped: 0, deferred: 0 });
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
        : { status: "translated", provider: "GROQ", model: "m", mode: "full" }
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
    assert.deepEqual(summary, { scanned: 0, translated: 0, failed: 0, skipped: 0, deferred: 0 });
  });

  it("squeezes each item's own budget down to what the run has left", async () => {
    // shouldStop is checked BEFORE an item; without this bound the item could then run its
    // full 210s and carry a 240s run past the route's 300s cap. Here the run has 60s left, so
    // the item must be given 60s, not 210s.
    const deps = makeDeps([makeCandidate("a")]);
    await translateFeedItems({ companyId: "c1", remainingMs: () => 60_000 }, deps);

    assert.equal(deps.calls.length, 1);
    assert.equal(deps.calls[0].itemTimeoutMs, 60_000);
  });

  it("never inflates an item's budget above its own cap when the run has plenty left", async () => {
    const deps = makeDeps([makeCandidate("a")]);
    await translateFeedItems({ companyId: "c1", remainingMs: () => 10 * 60_000 }, deps);
    assert.equal(deps.calls[0].itemTimeoutMs, TRANSLATION_ITEM_TIMEOUT_MS);
  });

  it("leaves the per-item budget untouched when the run does not report one", async () => {
    const deps = makeDeps([makeCandidate("a")]);
    await translateFeedItems({ companyId: "c1" }, deps);
    assert.equal(deps.calls[0].itemTimeoutMs, undefined, "pre-existing behaviour is unchanged");
  });

  it("stops instead of starting an item it can only time out on", async () => {
    // Below the floor no translation can finish, so starting one only spends a cross-run
    // attempt and schedules a backoff. The item stays pending for the continuation job.
    const deps = makeDeps([makeCandidate("a"), makeCandidate("b")]);
    const summary = await translateFeedItems(
      { companyId: "c1", remainingMs: () => MIN_TRANSLATION_ITEM_BUDGET_MS - 1 },
      deps
    );

    assert.equal(deps.calls.length, 0, "no item may start on an unusable budget");
    assert.deepEqual(summary, { scanned: 0, translated: 0, failed: 0, skipped: 0, deferred: 0 });
  });

  it("counts an item skipped for having no source text, without stopping the batch", async () => {
    // The service returns this WITHOUT an LLM call; the batch must treat it as any other
    // skip — counted, and the run continues.
    const deps = makeDeps([makeCandidate("empty"), makeCandidate("b")], (item) =>
      item.id === "empty"
        ? { status: "skipped", reason: "empty_source" }
        : { status: "translated", provider: "GROQ", model: "m", mode: "full" }
    );
    const summary = await translateFeedItems({ companyId: "c1" }, deps);

    assert.equal(summary.skipped, 1);
    assert.equal(summary.translated, 1);
    assert.equal(deps.calls.length, 2);
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

// ─── Size-aware admission: don't start what the run cannot finish ─────────────

/**
 * The flat {@link MIN_TRANSLATION_ITEM_BUDGET_MS} floor is one number for every
 * article, but MADLAD splits an article into HTTP batches and gives each a fair SHARE
 * of the item budget. So the longer the article, the less time each batch gets out of
 * the same remaining run budget — something a flat floor cannot see.
 *
 * Feed item 5bdc0e48-827e-4b73-9990-e5d3b0446b87 is the exact failure this prevents:
 * 99 segments / 4 batches, admitted because the run had 33,340ms left and
 * 33,340 > 20,000, whereupon MADLAD correctly computed floor(33,340 / 4) = 8,335ms per
 * batch and batch 1/4 aborted at ~8,335ms. Measured, the article needs ~82.8s.
 */
const MADLAD_ENV = {
  TRANSLATION_PROVIDER: "madlad",
  TEXT_WORKER_URL: "http://w:3002",
  TEXT_WORKER_API_KEY: "k",
};

/** Body long enough to segment into `n` sentences, so batch count is controllable. */
function bodyOfSentences(n: number): string {
  return Array.from({ length: n }, (_, i) => `Real sentence number ${i + 1} here.`).join(" ");
}

function longCandidate(id: string, sentences: number): Candidate {
  return { ...makeCandidate(id), content: bodyOfSentences(sentences) };
}

describe("translateFeedItems — size-aware admission", () => {
  it("defers a 4-batch article when the run has only the ~33s that broke 5bdc0e48", async () => {
    // 99 sentences + title → 4 batches at size 30 → needs 4 × 25s = 100s.
    const deps = makeDeps([longCandidate("big", 99)]);
    const summary = await translateFeedItems(
      { companyId: "c1", remainingMs: () => 33_340 },
      { ...deps, env: MADLAD_ENV }
    );

    assert.equal(deps.calls.length, 0, "the article that can only abort is never started");
    assert.equal(summary.deferred, 1);
    assert.equal(summary.scanned, 0, "a deferred item was never scanned, let alone attempted");
  });

  it("does not fail, claim, or otherwise touch a deferred item", async () => {
    const deps = makeDeps([longCandidate("big", 99)]);
    const summary = await translateFeedItems(
      { companyId: "c1", remainingMs: () => 33_340 },
      { ...deps, env: MADLAD_ENV }
    );

    // `translate` is what claims the item and increments its attempt count; never
    // calling it is exactly what keeps the item eligible with its attempts intact.
    assert.equal(deps.calls.length, 0);
    assert.equal(summary.failed, 0, "deferring is not failing");
    assert.equal(summary.skipped, 0, "nor is it skipping");
    assert.equal(summary.translated, 0);
  });

  it("still runs a short one-batch item on the same budget", async () => {
    // A handful of sentences → 1 batch → needs 25s, and 33.3s is enough.
    const deps = makeDeps([longCandidate("small", 5)]);
    const summary = await translateFeedItems(
      { companyId: "c1", remainingMs: () => 33_340 },
      { ...deps, env: MADLAD_ENV }
    );

    assert.equal(deps.calls.length, 1, "a small article still fits and must not be deferred");
    assert.equal(summary.translated, 1);
    assert.equal(summary.deferred, 0);
  });

  it("runs the SAME long article when the run has enough budget for it", async () => {
    const deps = makeDeps([longCandidate("big", 99)]);
    const summary = await translateFeedItems(
      { companyId: "c1", remainingMs: () => 200_000 },
      { ...deps, env: MADLAD_ENV }
    );

    assert.equal(deps.calls.length, 1);
    assert.equal(summary.translated, 1);
    assert.equal(summary.deferred, 0);
  });

  it("defers only the article that does not fit and keeps going", async () => {
    // `continue`, not `break`: a later short article can still be translated.
    const deps = makeDeps([longCandidate("big", 99), longCandidate("small", 4)]);
    const summary = await translateFeedItems(
      { companyId: "c1", remainingMs: () => 33_340 },
      { ...deps, env: MADLAD_ENV }
    );

    assert.deepEqual(
      deps.calls.map((c) => c.id),
      ["small"]
    );
    assert.equal(summary.deferred, 1);
    assert.equal(summary.translated, 1);
  });

  it("leaves the per-item timeout semantics untouched once an item IS admitted", async () => {
    const deps = makeDeps([longCandidate("big", 99)]);
    await translateFeedItems(
      { companyId: "c1", remainingMs: () => 150_000 },
      { ...deps, env: MADLAD_ENV }
    );

    // Still the pre-existing squeeze: min(TRANSLATION_ITEM_TIMEOUT_MS, remaining).
    assert.equal(deps.calls[0].itemTimeoutMs, 150_000);
    assert.ok(deps.calls[0].itemTimeoutMs! <= TRANSLATION_ITEM_TIMEOUT_MS);
  });

  it("does not apply to the prompt-based engine, whose cost does not scale with segments", async () => {
    // Ollama sends ONE request per article, so a long article is not more batches and
    // the flat floor already covers it. Nothing about that path may change here.
    const deps = makeDeps([longCandidate("big", 99)]);
    const summary = await translateFeedItems(
      { companyId: "c1", remainingMs: () => 33_340 },
      { ...deps, env: { TRANSLATION_PROVIDER: "ollama" } }
    );

    assert.equal(deps.calls.length, 1, "the Ollama path is unchanged by the MADLAD gate");
    assert.equal(summary.deferred, 0);
  });

  it("does not gate at all when the run reports no budget (the interactive path)", async () => {
    const deps = makeDeps([longCandidate("big", 99)]);
    const summary = await translateFeedItems({ companyId: "c1" }, { ...deps, env: MADLAD_ENV });

    assert.equal(deps.calls.length, 1);
    assert.equal(deps.calls[0].itemTimeoutMs, undefined, "no budget means no squeeze, as before");
    assert.equal(summary.deferred, 0);
  });
});
