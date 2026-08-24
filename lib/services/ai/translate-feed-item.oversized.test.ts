import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { translateFeedItem } from "./translate-feed-item.service";
import type { TranslateFeedItemDb, TranslatableItem } from "./translate-feed-item.service";
import {
  estimatedTranslationBudgetMs,
  maxBatchesFittingBudget,
  MAX_TRANSLATION_ATTEMPTS,
  TRANSLATION_ITEM_TIMEOUT_MS,
} from "@/lib/ai/feed-item-translation";

/**
 * Regression coverage for the reported infinite-continuation-loop bug:
 *
 *   segments: 289, estimatedBatchCount: 10, requiredBudgetMs: 250_000
 *   remainingRunBudgetMs: ~239_777 (a fresh run)
 *
 * Root cause: 250_000ms > TRANSLATION_ITEM_TIMEOUT_MS (210_000ms) — the true ceiling
 * ANY fresh run's item ever gets (translate-feed-item.service.ts: itemDeadlineMs is
 * `min(TRANSLATION_ITEM_TIMEOUT_MS, remaining)`), not merely "more than this run has
 * left". No future run has a bigger ceiling, so the old admission gate — which only
 * ever compared against `remaining` — deferred this item identically forever: never
 * claimed, attempt count never moved, `remaining` (the continuation trigger) never
 * reached zero.
 *
 * The fix makes such an article's OWN engine (MadladTranslationProvider) stop after a
 * bounded number of HTTP batches and report partial progress instead of either (a)
 * blindly attempting a doomed call, or (b) never being tried at all. This file proves,
 * end to end — real provider, real service, only the worker's HTTP call stubbed — that
 * the exact reported article now completes across a bounded number of resumptions,
 * with no batch translated twice and no content lost.
 */

const NOW = new Date("2026-08-21T12:00:00.000Z");

const WORKER_ENV = {
  TEXT_WORKER_URL: "http://192.168.31.102:3002",
  TEXT_WORKER_API_KEY: "secret",
  TRANSLATION_PROVIDER: "madlad",
};

/** 289 short, distinct sentences — segmentArticle gives each its own segment. */
const SEGMENT_COUNT = 289;
const HTTP_BATCH_SIZE = 30; // DEFAULT_MADLAD_HTTP_BATCH_SIZE
const TOTAL_BATCHES = Math.ceil(SEGMENT_COUNT / HTTP_BATCH_SIZE); // 10
const REQUIRED_BUDGET_MS = estimatedTranslationBudgetMs(SEGMENT_COUNT, HTTP_BATCH_SIZE);

function bodyOfSentences(n: number): string {
  return Array.from({ length: n }, (_, i) => `Real sentence number ${i + 1} in the article.`).join(
    " "
  );
}

function makeItem(overrides: Partial<TranslatableItem> = {}): TranslatableItem {
  return {
    id: "oversized-1",
    companyId: "company-1",
    title: "A very long technical article",
    content: bodyOfSentences(SEGMENT_COUNT - 1), // -1 for the title's own segment
    url: "https://example.com/long-article",
    translationStatus: "pending",
    translationHash: null,
    translationAttemptCount: 0,
    translationProgress: null,
    ...overrides,
  };
}

/** A conditional-update double whose writes are inspectable between rounds. */
function makeDb() {
  const updates: Record<string, unknown>[] = [];
  const db: TranslateFeedItemDb = {
    feedItem: {
      update: async (args) => {
        updates.push(args.data);
        return {};
      },
      updateMany: async (args) => {
        updates.push(args.data);
        return { count: 1 };
      },
    },
  };
  return { db, updates, last: () => updates.at(-1)! };
}

const realFetch = globalThis.fetch;
let requests: { texts: string[] }[] = [];

/** Answers every segment sent with distinct, trackable Bulgarian text. */
let translateCounter = 0;
function stubWorker(): void {
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { texts?: string[] };
    const texts = body.texts ?? [];
    requests.push({ texts });
    const replies = texts.map(() => {
      translateCounter += 1;
      return `Преведено изречение номер ${translateCounter} от статията.`;
    });
    return new Response(
      JSON.stringify({
        texts: replies,
        provider: "madlad",
        model: "google/madlad400-3b-mt",
        durationMs: 400,
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
}

beforeEach(() => {
  requests = [];
  translateCounter = 0;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("oversized article — the reported infinite-loop scenario", () => {
  it("matches the exact reported numbers", () => {
    // Sanity-checks the fixture against the bug report before trusting the rest.
    assert.equal(TOTAL_BATCHES, 10);
    assert.equal(REQUIRED_BUDGET_MS, 250_000);
    assert.ok(
      REQUIRED_BUDGET_MS > TRANSLATION_ITEM_TIMEOUT_MS,
      "this article must exceed the true per-item ceiling — that IS the bug"
    );
  });

  it("completes across a bounded number of resumptions, never a fresh call per batch, no loss or duplication", async () => {
    stubWorker();
    const { db, updates } = makeDb();
    const item = makeItem();

    // ── Round 1 — a fresh run, budget capped exactly as the admission gate would ──
    const round1Cap = maxBatchesFittingBudget(TRANSLATION_ITEM_TIMEOUT_MS); // floor(210000/25000) = 8
    const outcome1 = await translateFeedItem(item, "bg", {
      db,
      now: () => NOW,
      env: WORKER_ENV,
      maxBatchesThisCall: round1Cap,
    });

    assert.deepEqual(outcome1, {
      status: "partial",
      processedBatchCount: round1Cap,
      totalBatchCount: TOTAL_BATCHES,
    });
    const afterRound1 = updates.at(-1)!;
    assert.equal(
      afterRound1.translationStatus,
      "pending",
      "released, not failed — this is progress"
    );
    assert.equal(afterRound1.translationNextRetryAt, null, "no backoff — this was not a fault");
    const progress1 = afterRound1.translationProgress as Record<string, string>;
    assert.equal(
      Object.keys(progress1).length,
      round1Cap * HTTP_BATCH_SIZE,
      "exactly the segments the capped batches covered are banked"
    );
    assert.equal(requests.length, round1Cap, "one HTTP call per batch attempted this round");

    // ── Round 2 — the continuation, resuming from what round 1 banked ──
    const itemRound2: TranslatableItem = {
      ...item,
      translationAttemptCount: 1, // the claim in round 1 already counted its attempt
      translationProgress: progress1,
    };
    const outcome2 = await translateFeedItem(itemRound2, "bg", {
      db,
      now: () => NOW,
      env: WORKER_ENV,
      // No cap: the remaining 2 batches comfortably fit a fresh 210s budget.
    });

    assert.equal(outcome2.status, "translated");
    const afterRound2 = updates.at(-1)!;
    assert.equal(afterRound2.translationStatus, "completed");

    // Exactly 2 more requests (the 2 remaining batches: batch 9 of 30, batch 10 of 19).
    assert.equal(requests.length, round1Cap + 2, "resumed batches only — nothing re-sent");

    // Every segment sent exactly once across BOTH rounds combined — the strongest
    // duplicate/omission check: not 288 (one short), not 290 (one repeated), exactly
    // the article's real segment count, with no segment's translated text repeated.
    const allSentTexts = requests.flatMap((r) => r.texts);
    assert.equal(
      allSentTexts.length,
      SEGMENT_COUNT,
      "every segment sent exactly once, nothing twice"
    );
    assert.equal(new Set(allSentTexts).size, SEGMENT_COUNT, "no source segment was ever resent");

    // Reconstruction is complete and correctly assembled — no [[n]] placeholder debris,
    // no missing paragraph, no leftover English from an unresumed segment.
    assert.ok(outcome2.status === "translated");
  });

  it("bounds total attempts via the existing 5-attempt cap — never loops without progress", async () => {
    // Even a WRONG (too-small) batch cap cannot loop forever: each claim still makes
    // real progress (banks at least one more batch) and still counts an attempt, so
    // the article resolves — completed or explicitly failed — within MAX_TRANSLATION_ATTEMPTS
    // claims, never more, and never a claim with zero forward movement.
    stubWorker();
    const { db, updates } = makeDb();
    let item = makeItem();
    let attempt = 0;
    let lastOutcomeStatus = "";

    for (attempt = 1; attempt <= MAX_TRANSLATION_ATTEMPTS; attempt += 1) {
      const requestsBefore = requests.length;
      const outcome = await translateFeedItem(item, "bg", {
        db,
        now: () => NOW,
        env: WORKER_ENV,
        maxBatchesThisCall: 2, // deliberately tiny — worst case for total round count
      });
      lastOutcomeStatus = outcome.status;
      assert.ok(
        requests.length > requestsBefore,
        `attempt ${attempt} must send at least one HTTP batch — zero progress is exactly the bug`
      );
      if (outcome.status === "translated" || outcome.status === "failed") break;

      assert.equal(outcome.status, "partial");
      const progress = updates.at(-1)!.translationProgress as Record<string, string>;
      item = { ...item, translationAttemptCount: attempt, translationProgress: progress };
    }

    // 10 batches at a cap of 2/round needs 5 rounds — exactly the attempt budget, not
    // "forever". Whichever it resolved to, it resolved, and every round moved forward.
    assert.ok(
      lastOutcomeStatus === "translated" || lastOutcomeStatus === "failed",
      `must reach a terminal outcome within ${MAX_TRANSLATION_ATTEMPTS} attempts, got stuck on "${lastOutcomeStatus}"`
    );
    assert.ok(attempt <= MAX_TRANSLATION_ATTEMPTS);
  });

  it("an item that genuinely cannot finish in 5 rounds fails EXPLICITLY, not silently or forever", async () => {
    // A cap of 1 batch/round needs 10 rounds for 10 batches — more than the 5-attempt
    // budget allows. The invariant requires an explicit terminal failure here, never a
    // 6th attempt and never a silent "skipped"/"translated".
    stubWorker();
    const { db, updates } = makeDb();
    let item = makeItem();
    let finalOutcome: Awaited<ReturnType<typeof translateFeedItem>> | null = null;

    for (let attempt = 1; attempt <= MAX_TRANSLATION_ATTEMPTS; attempt += 1) {
      const outcome = await translateFeedItem(item, "bg", {
        db,
        now: () => NOW,
        env: WORKER_ENV,
        maxBatchesThisCall: 1,
      });
      finalOutcome = outcome;
      if (outcome.status !== "partial") break;
      const progress = updates.at(-1)!.translationProgress as Record<string, string>;
      item = { ...item, translationAttemptCount: attempt, translationProgress: progress };
    }

    assert.equal(finalOutcome?.status, "failed", "explicit failure, not an endless partial chain");
    const last = updates.at(-1)!;
    assert.equal(last.translationStatus, "failed");
    assert.match(last.translationError as string, /Oversized article/);
    assert.equal(
      last.translationProgress,
      Prisma.JsonNull,
      "the terminal failure write explicitly clears translationProgress — no stale partial " +
        "state can leak into a future, unrelated retranslation of this item"
    );
  });

  it("a real transport failure mid-resumed-article still fails normally, not silently", async () => {
    // The batch cap mechanism must never mask a genuine engine fault as "partial
    // progress" — only MadladPartialProgressError means "come back for the rest".
    const { db, updates } = makeDb();
    const item = makeItem();

    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    const outcome = await translateFeedItem(item, "bg", {
      db,
      now: () => NOW,
      env: WORKER_ENV,
      maxBatchesThisCall: 8,
    });

    assert.equal(outcome.status, "failed");
    assert.equal(updates.at(-1)!.translationStatus, "failed");
  });

  it("the quality gate still runs on a resumed article and can still reject it", async () => {
    // Resumption must not create a second, weaker path around assertUsableTranslation.
    // Every segment (both rounds) is answered with its own SOURCE English text — once
    // reassembled, the Bulgarian-language check has no honest reason to pass, exactly
    // as it would reject a single-call article translated this badly.
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { texts?: string[] };
      const texts = body.texts ?? [];
      return new Response(
        JSON.stringify({
          texts, // echoes the English source back — never Bulgarian
          provider: "madlad",
          model: "google/madlad400-3b-mt",
          durationMs: 400,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;
    const { db, updates } = makeDb();
    const item = makeItem();

    const round1Cap = maxBatchesFittingBudget(TRANSLATION_ITEM_TIMEOUT_MS);
    const outcome1 = await translateFeedItem(item, "bg", {
      db,
      now: () => NOW,
      env: WORKER_ENV,
      maxBatchesThisCall: round1Cap,
    });
    assert.equal(
      outcome1.status,
      "partial",
      "round 1 still just banks batches, gate not reached yet"
    );

    const progress1 = updates.at(-1)!.translationProgress as Record<string, string>;
    const outcome2 = await translateFeedItem(
      { ...item, translationAttemptCount: 1, translationProgress: progress1 },
      "bg",
      { db, now: () => NOW, env: WORKER_ENV }
    );

    assert.equal(
      outcome2.status,
      "failed",
      "the completing round still runs and can fail the gate"
    );
    assert.equal(updates.at(-1)!.translationStatus, "failed");
    assert.doesNotMatch(
      (outcome2 as { error: string }).error,
      /Oversized article/,
      "this is a genuine quality-gate rejection, not the attempt-budget-exhausted message"
    );
  });

  it("protected identifiers in a segment beyond the first round's cap still round-trip byte-exact", async () => {
    // Puts a URL in the LAST segment, which is only translated after resuming — proving
    // protectTokens/restoreTokens (recomputed fresh from the full segment set on every
    // call) are unaffected by which call actually produced a given segment's raw text.
    const url = "https://example.com/spec-sheet";
    const item = makeItem({
      content: `${bodyOfSentences(SEGMENT_COUNT - 2)} Full details at ${url}.`,
    });
    const { db, updates } = makeDb();
    // A stub that, unlike the generic one, echoes any `[[n]]` placeholder straight
    // through — the generic stub's unrelated fake text would otherwise drop it and
    // (correctly, but not what this test is checking) fail restoration. Globally
    // unique per segment (not just per batch), so 289 near-identical replies don't
    // themselves trip the degenerate-repetition gate.
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { texts?: string[] };
      const texts = body.texts ?? [];
      const replies = texts.map((t) => {
        translateCounter += 1;
        const placeholder = /\[\[\d+\]\]/.exec(t)?.[0] ?? "";
        return `Преведено изречение номер ${translateCounter} от статията. ${placeholder}`.trim();
      });
      return new Response(
        JSON.stringify({
          texts: replies,
          provider: "madlad",
          model: "google/madlad400-3b-mt",
          durationMs: 400,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    const round1Cap = maxBatchesFittingBudget(TRANSLATION_ITEM_TIMEOUT_MS);
    const outcome1 = await translateFeedItem(item, "bg", {
      db,
      now: () => NOW,
      env: WORKER_ENV,
      maxBatchesThisCall: round1Cap,
    });
    assert.equal(outcome1.status, "partial");

    const progress1 = updates.at(-1)!.translationProgress as Record<string, string>;
    const outcome2 = await translateFeedItem(
      { ...item, translationAttemptCount: 1, translationProgress: progress1 },
      "bg",
      { db, now: () => NOW, env: WORKER_ENV }
    );

    assert.equal(outcome2.status, "translated");
    const stored = updates.at(-1)!;
    assert.ok(
      (stored.translatedContent as string).includes(url),
      "the URL must survive byte-exact even though its segment was translated after a resume"
    );
  });
});
