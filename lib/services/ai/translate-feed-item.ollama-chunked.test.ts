import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { translateFeedItem } from "./translate-feed-item.service";
import type { TranslatableItem, TranslateFeedItemDb } from "./translate-feed-item.service";
import { MAX_TRANSLATION_ATTEMPTS } from "@/lib/ai/feed-item-translation";
import type { LlmRequest } from "@/lib/ai/types";

/**
 * The chunked Ollama path's oversized-article behaviour, end to end through
 * `translateFeedItem` — the sibling of translate-feed-item.oversized.test.ts, which
 * covers the SAME shape of scenario for MADLAD.
 *
 * The one thing worth proving here that the provider-level tests
 * (ollama-translation.provider.test.ts) cannot: what `translateFeedItem` actually
 * WRITES to the database on a permanently-failing chunk, on both a non-final and a
 * final cross-run attempt — and specifically that it diverges from MADLAD's own
 * choice on the final one. MADLAD clears `translationProgress` when its attempt
 * budget is exhausted (a stale batch under an old worker setting must never silently
 * resume); the chunked Ollama path PRESERVES it, because each chunk already passed
 * its own full retry/validation cycle before being banked, so there is no "under old
 * settings" risk — only the cost of re-translating chunks that already succeeded,
 * which a later retry should not have to pay twice (requirement: "if a chunk
 * permanently fails, keep the article failed and preserve progress for a later retry").
 */

const NOW = new Date("2026-08-25T12:00:00.000Z");

const FILLER_SENTENCES = [
  "The new revision brings a redesigned chassis and a wider range of mounting options.",
  "Reviewers noted the improved thermal performance under sustained load.",
  "Early benchmarks show a measurable gain over the previous generation.",
  "The manufacturer says the change was driven directly by customer feedback.",
  "Supply constraints delayed the rollout in several regional markets.",
  "A firmware update addressed the initial reports of instability.",
];

function paragraphWithMarker(marker: string, minChars: number, seed = 0): string {
  const sentences = [`${marker} is the subject of this section.`];
  let len = sentences[0].length;
  let i = seed;
  while (len < minChars) {
    const s = FILLER_SENTENCES[i % FILLER_SENTENCES.length];
    sentences.push(s);
    len += s.length + 1;
    i += 1;
  }
  return sentences.join(" ");
}

const BG_FILLER = "Преведен текст на естествен и правилен български език за целите на теста.";

/** Two chunks: ALPHAMARKER always succeeds, BETAMARKER always degenerates into a loop. */
const CONTENT = [
  paragraphWithMarker("ALPHAMARKER", 2600, 0),
  paragraphWithMarker("BETAMARKER", 2600, 3),
].join("\n\n");

function alwaysFailsBetaGenerate() {
  return async (request: LlmRequest) => {
    if (request.userPrompt.startsWith("Title: ") && !request.userPrompt.includes("\nContent: ")) {
      return { text: JSON.stringify({ title: BG_FILLER }) };
    }
    const body = request.userPrompt.replace(/^Passage \d+ of \d+:\n/, "");
    if (body.includes("BETAMARKER")) {
      return { text: JSON.stringify({ content: "със със със със със със" }) };
    }
    return { text: JSON.stringify({ content: `${BG_FILLER} ALPHAMARKER` }) };
  };
}

/** Every unit succeeds cleanly — for the diagnostics tests below, which need a
 *  complete, successful chunked translation rather than a partial/failing one. */
function alwaysSucceedsGenerate() {
  return async (request: LlmRequest) => {
    if (request.userPrompt.startsWith("Title: ") && !request.userPrompt.includes("\nContent: ")) {
      return { text: JSON.stringify({ title: BG_FILLER }) };
    }
    return { text: JSON.stringify({ content: BG_FILLER }) };
  };
}

/** Captures console.info calls, restoring the original on stop(). */
function captureInfo() {
  const infos: unknown[][] = [];
  const orig = console.info;
  console.info = (...args: unknown[]) => void infos.push(args);
  return { infos, stop: () => (console.info = orig) };
}

function makeItem(overrides: Partial<TranslatableItem> = {}): TranslatableItem {
  return {
    id: "item-chunked-1",
    companyId: "company-1",
    title: "A large technical article",
    content: CONTENT,
    url: "https://example.com/large-article",
    translationStatus: "pending",
    translationHash: null,
    translationAttemptCount: 0,
    translationProgress: null,
    ...overrides,
  };
}

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

function deps(db: TranslateFeedItemDb, generate: (req: LlmRequest) => Promise<{ text: string }>) {
  return {
    db,
    now: () => NOW,
    resolveProvider: async () =>
      ({ ok: true, instance: { generate }, provider: "TEXT_WORKER", model: "qwen3:8b" }) as const,
    // Ollama is the default engine — no TRANSLATION_PROVIDER override needed. `env: {}`
    // just makes sure a real process.env cannot leak a `TRANSLATION_PROVIDER=madlad`
    // into this test and change which engine actually runs.
    env: {},
  };
}

describe("translateFeedItem — chunked Ollama path, a permanently-failing chunk", () => {
  it("on a NON-final attempt: banks the good chunk, no backoff, resumes immediately", async () => {
    const { db, last } = makeDb();
    const item = makeItem({ translationAttemptCount: 1 }); // attempt 2 of 5 — not final

    const outcome = await translateFeedItem(item, "bg", deps(db, alwaysFailsBetaGenerate()));

    assert.equal(outcome.status, "partial");
    const write = last();
    assert.equal(write.translationStatus, "pending");
    assert.equal(write.translationNextRetryAt, null, "not a fault — no backoff");
    const progress = write.translationProgress as Record<string, string>;
    assert.ok("title" in progress, "the title must be banked");
    assert.ok("0" in progress, "ALPHAMARKER's chunk must be banked");
    assert.equal(Object.keys(progress).length, 2, "BETAMARKER's chunk must NOT be banked");
  });

  it("on the FINAL attempt: fails the item but PRESERVES the banked progress", async () => {
    const { db, last } = makeDb();
    // attempt = translationAttemptCount + 1 = MAX_TRANSLATION_ATTEMPTS on this claim.
    const item = makeItem({ translationAttemptCount: MAX_TRANSLATION_ATTEMPTS - 1 });

    const outcome = await translateFeedItem(item, "bg", deps(db, alwaysFailsBetaGenerate()));

    assert.equal(outcome.status, "failed");
    const write = last();
    assert.equal(write.translationStatus, "failed");
    assert.ok(write.translationNextRetryAt instanceof Date, "a genuine failure DOES get a backoff");

    // The divergence from MADLAD: progress survives the terminal failure rather than
    // being cleared, because every banked chunk here already passed its own full
    // retry/validation cycle — there is no "stale batch under old settings" risk to
    // guard against, only the cost of re-translating what already succeeded.
    assert.notEqual(
      write.translationProgress,
      Prisma.JsonNull,
      "the chunked path must not clear progress the way MADLAD does"
    );
    const progress = write.translationProgress as Record<string, string>;
    assert.ok("title" in progress && "0" in progress);
    assert.equal(Object.keys(progress).length, 2);
  });

  it("the failure message names chunks, not MADLAD HTTP batches", async () => {
    const { db, last } = makeDb();
    const item = makeItem({ translationAttemptCount: MAX_TRANSLATION_ATTEMPTS - 1 });

    await translateFeedItem(item, "bg", deps(db, alwaysFailsBetaGenerate()));

    const message = last().translationError as string;
    assert.match(message, /chunk\(s\)/);
    assert.doesNotMatch(message, /MADLAD/);
  });

  it("a later attempt resumes from the preserved progress and never re-sends the banked chunk", async () => {
    const { db, last } = makeDb();
    const firstItem = makeItem({ translationAttemptCount: MAX_TRANSLATION_ATTEMPTS - 1 });
    await translateFeedItem(firstItem, "bg", deps(db, alwaysFailsBetaGenerate()));
    const bankedProgress = last().translationProgress as Record<string, string>;

    // A fresh cross-run try (e.g. after a manual "Retranslate" or a config fix),
    // resuming from what the failed run preserved. This time BETAMARKER succeeds too.
    let calls = 0;
    const recoveredGenerate = async (request: LlmRequest) => {
      calls += 1;
      const body = request.userPrompt.replace(/^Passage \d+ of \d+:\n/, "");
      return {
        text: JSON.stringify({
          content: `${BG_FILLER} ${body.includes("BETA") ? "BETAMARKER" : ""}`,
        }),
      };
    };
    const { db: db2 } = makeDb();
    const resumedItem = makeItem({
      translationAttemptCount: 0,
      translationProgress: bankedProgress,
    });
    const outcome = await translateFeedItem(resumedItem, "bg", deps(db2, recoveredGenerate));

    assert.equal(outcome.status, "translated");
    // Only the ONE chunk that failed before is re-sent.
    assert.equal(calls, 1);
  });
});

describe("translateFeedItem — chunked Ollama path diagnostics", () => {
  it("names the engine as Chunked, not MADLAD, when banking progress mid-run", async () => {
    const { db } = makeDb();
    const item = makeItem({ translationAttemptCount: 1 }); // attempt 2 of 5 — not final
    const cap = captureInfo();
    try {
      await translateFeedItem(item, "bg", deps(db, alwaysFailsBetaGenerate()));
    } finally {
      cap.stop();
    }

    const progressing = cap.infos.find(
      (a) => typeof a[0] === "string" && (a[0] as string).includes("article progressing")
    );
    assert.ok(progressing, "expected a progress log line");
    assert.equal(
      progressing![0],
      "[rss-translation] Chunked article progressing — resuming next run"
    );
  });

  it("reports the FULL sanitised body length translated, not the ~3000-char single-call cap", async () => {
    const { db } = makeDb();
    const item = makeItem(); // fresh claim — will translate the whole article successfully
    const cap = captureInfo();
    let outcome;
    try {
      outcome = await translateFeedItem(item, "bg", deps(db, alwaysSucceedsGenerate()));
    } finally {
      cap.stop();
    }

    assert.equal(outcome.status, "translated");
    const done = cap.infos.find((a) => a[0] === "[rss-translation] item translated");
    assert.ok(done, "expected an 'item translated' log");
    const fields = done![1] as Record<string, unknown>;
    assert.ok(
      (fields.translatedBodyChars as number) > 3000,
      `expected the full body length reported, not the ~3000-char single-call cap, got ${fields.translatedBodyChars}`
    );
    assert.ok(
      Math.abs((fields.translatedBodyChars as number) - CONTENT.length) < 5,
      `expected close to the article's own ${CONTENT.length} chars, got ${fields.translatedBodyChars}`
    );
  });
});
