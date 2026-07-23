import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  translateFeedItem,
  type TranslatableItem,
  type TranslateFeedItemDeps,
} from "./translate-feed-item.service";
import { computeTranslationHash, MAX_TRANSLATION_ATTEMPTS } from "@/lib/ai/feed-item-translation";

// ─── Fakes ────────────────────────────────────────────────────────────────────

/** Records every update so tests can assert on the exact write sequence. */
function makeDb() {
  const updates: Array<Record<string, unknown>> = [];
  return {
    updates,
    feedItem: {
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push(args.data);
        return {};
      },
    },
  };
}

const NOW = new Date("2026-07-16T12:00:00.000Z");

function makeItem(overrides: Partial<TranslatableItem> = {}): TranslatableItem {
  return {
    id: "item-1",
    title: "Original title",
    content: "Original content",
    url: "https://example.com/article",
    translationStatus: "pending",
    translationHash: null,
    translationAttemptCount: 0,
    ...overrides,
  };
}

function makeDeps(
  db: ReturnType<typeof makeDb>,
  generate: () => Promise<{ text: string }>,
  providerOk = true
): TranslateFeedItemDeps {
  return {
    db,
    now: () => NOW,
    resolveProvider: async () =>
      providerOk
        ? { ok: true, instance: { generate }, provider: "GROQ", model: "llama-3.3-70b-versatile" }
        : { ok: false },
  };
}

const GOOD_RESPONSE = '{"title":"Заглавие","content":"Съдържание"}';

// ─── Success ──────────────────────────────────────────────────────────────────

describe("translateFeedItem — success", () => {
  let db: ReturnType<typeof makeDb>;

  beforeEach(() => {
    db = makeDb();
  });

  it("stores the translation, provider metadata, and the input hash", async () => {
    const item = makeItem();
    const outcome = await translateFeedItem(
      item,
      "bg",
      makeDeps(db, async () => ({ text: GOOD_RESPONSE }))
    );

    assert.deepEqual(outcome, {
      status: "translated",
      provider: "GROQ",
      model: "llama-3.3-70b-versatile",
    });

    const final = db.updates.at(-1)!;
    assert.equal(final.translationStatus, "completed");
    assert.equal(final.translatedTitle, "Заглавие");
    assert.equal(final.translatedContent, "Съдържание");
    assert.equal(final.translationLanguage, "bg");
    assert.equal(final.translationProvider, "GROQ");
    assert.equal(final.translationModel, "llama-3.3-70b-versatile");
    assert.equal(final.translationHash, computeTranslationHash(item.title, item.content, "bg"));
    assert.equal(final.translationError, null);
    assert.equal(final.translationNextRetryAt, null);
    assert.equal(final.translatedAt, NOW);
  });

  it("never writes the original title or content", async () => {
    await translateFeedItem(
      makeItem(),
      "bg",
      makeDeps(db, async () => ({ text: GOOD_RESPONSE }))
    );

    for (const data of db.updates) {
      assert.ok(!("title" in data), "translation must not write title");
      assert.ok(!("content" in data), "translation must not write content");
    }
  });

  it("counts the attempt and stamps lastAttemptAt before calling the model", async () => {
    let dbWritesBeforeCall = 0;
    await translateFeedItem(
      makeItem(),
      "bg",
      makeDeps(db, async () => {
        dbWritesBeforeCall = db.updates.length;
        return { text: GOOD_RESPONSE };
      })
    );

    assert.equal(dbWritesBeforeCall, 1, "attempt must be recorded before the LLM call");
    const attempt = db.updates[0];
    assert.deepEqual(attempt.translationAttemptCount, { increment: 1 });
    assert.equal(attempt.translationLastAttemptAt, NOW);
    assert.equal(attempt.translationStatus, "pending");
  });
});

// ─── Hash skip ────────────────────────────────────────────────────────────────

describe("translateFeedItem — unchanged content", () => {
  it("skips the LLM entirely when the hash matches a completed translation", async () => {
    const db = makeDb();
    let called = false;
    const item = makeItem({
      translationStatus: "completed",
      translationHash: computeTranslationHash("Original title", "Original content", "bg"),
    });

    const outcome = await translateFeedItem(
      item,
      "bg",
      makeDeps(db, async () => {
        called = true;
        return { text: GOOD_RESPONSE };
      })
    );

    assert.deepEqual(outcome, { status: "skipped", reason: "unchanged" });
    assert.equal(called, false);
    assert.equal(db.updates.length, 0, "an unchanged item must not be written at all");
  });

  it("re-translates when the same hash is present but the status is not completed", async () => {
    const db = makeDb();
    const item = makeItem({
      translationStatus: "failed",
      translationHash: computeTranslationHash("Original title", "Original content", "bg"),
      translationAttemptCount: 1,
    });

    const outcome = await translateFeedItem(
      item,
      "bg",
      makeDeps(db, async () => ({ text: GOOD_RESPONSE }))
    );

    assert.equal(outcome.status, "translated");
  });

  it("re-translates a completed item when the target language changed", async () => {
    const db = makeDb();
    const item = makeItem({
      translationStatus: "completed",
      translationHash: computeTranslationHash("Original title", "Original content", "bg"),
    });

    const outcome = await translateFeedItem(
      item,
      "en",
      makeDeps(db, async () => ({ text: GOOD_RESPONSE }))
    );

    assert.equal(outcome.status, "translated");
  });
});

// ─── Failure + retry ──────────────────────────────────────────────────────────

describe("translateFeedItem — failure", () => {
  it("records the error and schedules the first backoff", async () => {
    const db = makeDb();
    const outcome = await translateFeedItem(
      makeItem(),
      "bg",
      makeDeps(db, async () => {
        throw new Error("provider exploded");
      })
    );

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.status === "failed" && outcome.error, "provider exploded");

    const final = db.updates.at(-1)!;
    assert.equal(final.translationStatus, "failed");
    assert.equal(final.translationError, "provider exploded");
    // Attempt 1 → 5 minutes.
    assert.equal((final.translationNextRetryAt as Date).getTime(), NOW.getTime() + 5 * 60 * 1000);
  });

  it("counts a TRUNCATED 200 response as failed (the real HTTP-200-but-failed case)", async () => {
    // The worker returns HTTP 200, but the model hit its output limit mid-JSON, so the body
    // is cut off before the closing quote/brace. The strict parser rejects it → the item is
    // failed even though the transport succeeded. This is the production symptom the content
    // cap prevents by keeping generation within limits.
    const db = makeDb();
    const truncated = '{"title":"Заглавие","content":"Частичен превод, който бе отря';
    const outcome = await translateFeedItem(
      makeItem(),
      "bg",
      makeDeps(db, async () => ({ text: truncated }))
    );

    assert.equal(outcome.status, "failed");
    assert.match(outcome.status === "failed" ? outcome.error : "", /JSON/i);
    assert.equal(db.updates.at(-1)!.translationStatus, "failed");
  });

  it("treats a malformed JSON response as a failure and counts the attempt", async () => {
    const db = makeDb();
    const outcome = await translateFeedItem(
      makeItem(),
      "bg",
      makeDeps(db, async () => ({ text: "I'm afraid I can't do that." }))
    );

    assert.equal(outcome.status, "failed");
    assert.deepEqual(db.updates[0].translationAttemptCount, { increment: 1 });
    assert.equal(db.updates.at(-1)!.translationStatus, "failed");
  });

  it("lengthens the backoff as attempts accumulate", async () => {
    const db = makeDb();
    const outcome = await translateFeedItem(
      makeItem({ translationStatus: "failed", translationAttemptCount: 2 }),
      "bg",
      makeDeps(db, async () => {
        throw new Error("still down");
      })
    );

    // The 3rd attempt → 2 hours.
    assert.equal(
      outcome.status === "failed" && outcome.nextRetryAt.getTime(),
      NOW.getTime() + 2 * 60 * 60 * 1000
    );
  });

  it("stops retrying once the attempt cap is reached", async () => {
    const db = makeDb();
    let called = false;
    const outcome = await translateFeedItem(
      makeItem({ translationStatus: "failed", translationAttemptCount: MAX_TRANSLATION_ATTEMPTS }),
      "bg",
      makeDeps(db, async () => {
        called = true;
        return { text: GOOD_RESPONSE };
      })
    );

    assert.deepEqual(outcome, { status: "skipped", reason: "max_attempts" });
    assert.equal(called, false);
    assert.equal(db.updates.length, 0);
  });
});

// ─── Diagnostics logging ────────────────────────────────────────────────────────

/** Captures console.info/console.warn calls, restoring the originals on stop(). */
function captureConsole() {
  const infos: unknown[][] = [];
  const warns: unknown[][] = [];
  const origInfo = console.info;
  const origWarn = console.warn;
  console.info = (...args: unknown[]) => void infos.push(args);
  console.warn = (...args: unknown[]) => void warns.push(args);
  return {
    infos,
    warns,
    stop: () => {
      console.info = origInfo;
      console.warn = origWarn;
    },
    /** Serialised form of every captured line — used to assert the body never leaks. */
    allText: () => [...infos, ...warns].map((a) => JSON.stringify(a)).join("\n"),
  };
}

describe("translateFeedItem — diagnostics", () => {
  const SECRET_BODY = "SUPER_SECRET_ARTICLE_BODY_9182_should_never_be_logged";

  it("logs id, title, source URL, prompt length, article length, and elapsed — never the body", async () => {
    const db = makeDb();
    const cap = captureConsole();
    try {
      await translateFeedItem(
        makeItem({ title: "Public Title", content: SECRET_BODY, url: "https://news.example/x" }),
        "bg",
        makeDeps(db, async () => ({ text: GOOD_RESPONSE }))
      );
    } finally {
      cap.stop();
    }

    // A start line names the in-flight item with all required fields.
    const start = cap.infos.find((a) => a[0] === "[rss-translation] translating item");
    assert.ok(start, "expected a 'translating item' log");
    const startPayload = start![1] as Record<string, unknown>;
    assert.equal(startPayload.feedItemId, "item-1");
    assert.equal(startPayload.title, "Public Title");
    assert.equal(startPayload.sourceUrl, "https://news.example/x");
    assert.equal(startPayload.articleTextLength, SECRET_BODY.length);
    assert.ok((startPayload.promptLength as number) > 0);

    // A completion line carries the elapsed time.
    const done = cap.infos.find((a) => a[0] === "[rss-translation] item translated");
    assert.ok(done, "expected an 'item translated' log");
    assert.equal(typeof (done![1] as Record<string, unknown>).elapsedMs, "number");

    // The article body must never appear in any logged line.
    assert.ok(!cap.allText().includes(SECRET_BODY), "the article body must not be logged");
  });

  it("on failure (e.g. a timeout) logs exactly which feed item failed", async () => {
    const db = makeDb();
    const cap = captureConsole();
    try {
      await translateFeedItem(
        makeItem({ id: "item-42", url: "https://news.example/slow", content: SECRET_BODY }),
        "bg",
        makeDeps(db, async () => {
          throw new Error("Text worker request exceeded its deadline");
        })
      );
    } finally {
      cap.stop();
    }

    const failed = cap.warns.find((a) => a[0] === "[rss-translation] item translation FAILED");
    assert.ok(failed, "expected a FAILED log on timeout");
    const payload = failed![1] as Record<string, unknown>;
    assert.equal(payload.feedItemId, "item-42");
    assert.equal(payload.sourceUrl, "https://news.example/slow");
    assert.equal(payload.error, "Text worker request exceeded its deadline");
    assert.equal(typeof payload.elapsedMs, "number");
    assert.ok(!cap.allText().includes(SECRET_BODY), "the article body must not be logged");
  });
});

// ─── Provider availability ────────────────────────────────────────────────────

describe("translateFeedItem — no provider", () => {
  it("does not burn an attempt when no default provider is configured", async () => {
    const db = makeDb();
    const outcome = await translateFeedItem(
      makeItem(),
      "bg",
      makeDeps(db, async () => ({ text: GOOD_RESPONSE }), false)
    );

    assert.deepEqual(outcome, { status: "no_provider" });
    assert.equal(db.updates.length, 0, "a missing provider must not count as an attempt");
  });
});
