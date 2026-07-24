import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  translateFeedItem,
  type TranslatableItem,
  type TranslateFeedItemDeps,
} from "./translate-feed-item.service";
import { computeTranslationHash, MAX_TRANSLATION_ATTEMPTS } from "@/lib/ai/feed-item-translation";

// ─── Fakes ────────────────────────────────────────────────────────────────────

/**
 * A faithful conditional-UPDATE double for one feed_items row. `update` writes
 * unconditionally by id (the success path); `updateMany` applies its data only when the
 * row matches the WHERE and reports how many rows changed — exactly the semantics the
 * atomic claim and the guarded failure write rely on. The matcher understands only the
 * operators those two writes use (in / lt / lte / not / null / Date equality / OR), so a
 * claim on an ineligible row, or a failure whose lease no longer matches, reports count 0.
 */
interface RowState {
  translationStatus: string | null;
  translationHash: string | null;
  translationAttemptCount: number;
  translationNextRetryAt: Date | null;
  translationLeaseExpiresAt: Date | null;
}

const num = (v: unknown): number =>
  v instanceof Date ? v.getTime() : typeof v === "number" ? v : NaN;

function matchLeaf(value: unknown, cond: unknown): boolean {
  if (cond === null) return value === null;
  if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
  if (typeof cond === "object") {
    const c = cond as Record<string, unknown>;
    if ("in" in c) return (c.in as unknown[]).includes(value);
    if ("lt" in c) return value != null && num(value) < num(c.lt);
    if ("lte" in c) return value != null && num(value) <= num(c.lte);
    if ("not" in c) return value !== c.not;
  }
  return value === cond;
}

function makeDb(init: Partial<RowState> = {}) {
  const row: RowState = {
    translationStatus: "pending",
    translationHash: null,
    translationAttemptCount: 0,
    translationNextRetryAt: null,
    translationLeaseExpiresAt: null,
    ...init,
  };
  const updates: Array<Record<string, unknown>> = [];

  const matches = (where: Record<string, unknown>): boolean => {
    for (const [k, v] of Object.entries(where)) {
      if (k === "id") continue;
      if (k === "OR") {
        if (!(v as Record<string, unknown>[]).some((sub) => matches(sub))) return false;
        continue;
      }
      if (!matchLeaf((row as unknown as Record<string, unknown>)[k], v)) return false;
    }
    return true;
  };

  const apply = (data: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(data)) {
      if (k === "translationAttemptCount" && v && typeof v === "object" && "increment" in v) {
        row.translationAttemptCount += (v as { increment: number }).increment;
      } else if (k in row) {
        (row as unknown as Record<string, unknown>)[k] = v;
      }
    }
    updates.push(data);
  };

  return {
    updates,
    /** Simulate a concurrent run mutating this row (used by the race test). */
    setStatus: (s: string) => {
      row.translationStatus = s;
    },
    get currentStatus() {
      return row.translationStatus;
    },
    feedItem: {
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        apply(args.data);
        return {};
      },
      updateMany: async (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        if (!matches(args.where)) return { count: 0 };
        apply(args.data);
        return { count: 1 };
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
  generate: () => Promise<{ text: string; raw?: unknown }>,
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

    assert.equal(dbWritesBeforeCall, 1, "the claim must be recorded before the LLM call");
    const attempt = db.updates[0];
    assert.deepEqual(attempt.translationAttemptCount, { increment: 1 });
    assert.equal(attempt.translationLastAttemptAt, NOW);
    // The pre-call write is now the atomic claim, which flips the row to `translating`.
    assert.equal(attempt.translationStatus, "translating");
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
    const db = makeDb({ translationStatus: "failed", translationAttemptCount: 1 });
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
    const db = makeDb({
      translationStatus: "completed",
      translationHash: computeTranslationHash("Original title", "Original content", "bg"),
    });
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

  it("completes a 200 reply truncated just before its closing brace (the real qwen3 case)", async () => {
    // The worker returns HTTP 200 with a full title + content but no trailing "}". This is
    // recoverable — the strings are terminated — so the item translates instead of failing.
    const db = makeDb();
    const missingBrace = '{"title":"Заглавие","content":"Пълно съдържание"';
    const outcome = await translateFeedItem(
      makeItem(),
      "bg",
      makeDeps(db, async () => ({ text: missingBrace }))
    );

    assert.equal(outcome.status, "translated");
    const final = db.updates.at(-1)!;
    assert.equal(final.translationStatus, "completed");
    assert.equal(final.translatedTitle, "Заглавие");
    assert.equal(final.translatedContent, "Пълно съдържание");
  });

  it("does not resurrect a failed status when a concurrent run already completed the item", async () => {
    // Defense in depth on top of the claim: even if two runs both reach the failure write
    // (e.g. a lease-expiry hand-off), the guarded write must never overwrite a row another run
    // has since completed. Here a concurrent run completes the item while this run's request is
    // in flight; this run then fails. The lease-fenced failure write matches no row — otherwise
    // the UI would show "Translation failed" for an item that is actually translated.
    const db = makeDb();
    const outcome = await translateFeedItem(
      makeItem(),
      "bg",
      makeDeps(db, async () => {
        db.setStatus("completed"); // a concurrent run finishes the translation first
        throw new Error("Translation response was not valid JSON.");
      })
    );

    // The item stays completed, and no "failed" state is ever persisted.
    assert.equal(db.currentStatus, "completed");
    assert.ok(
      !db.updates.some((d) => d.translationStatus === "failed"),
      "a superseded failure must not write a failed status"
    );
    // This run translated nothing — it reports skipped; the concurrent run counts the success.
    assert.equal(outcome.status, "skipped");
    assert.equal(outcome.status === "skipped" && outcome.reason, "superseded");
  });

  it("skips without calling the model when another run already holds the claim", async () => {
    // The item is already claimed (translating, live lease) by a concurrent run. This run's
    // atomic claim matches no row, so it must NOT call the LLM and must report skipped.
    const db = makeDb({
      translationStatus: "translating",
      translationLeaseExpiresAt: new Date(NOW.getTime() + 5 * 60_000),
      translationAttemptCount: 1,
    });
    let called = false;
    const outcome = await translateFeedItem(
      makeItem(),
      "bg",
      makeDeps(db, async () => {
        called = true;
        return { text: GOOD_RESPONSE };
      })
    );

    assert.equal(called, false, "a lost claim must not reach the LLM");
    assert.deepEqual(outcome, { status: "skipped", reason: "claimed" });
    assert.equal(db.updates.length, 0, "a lost claim writes nothing");
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
    const db = makeDb({ translationStatus: "failed", translationAttemptCount: 2 });
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

  it("logs prompt/completion token estimates and Ollama durations on success", async () => {
    // These diagnostics let a timeout be correlated with size, and reveal when Ollama hit the
    // num_predict ceiling (done_reason="length") vs finished cleanly ("stop").
    const db = makeDb();
    const cap = captureConsole();
    try {
      await translateFeedItem(
        makeItem(),
        "bg",
        makeDeps(db, async () => ({
          text: GOOD_RESPONSE,
          // The worker forwarded Ollama's metrics (durations in nanoseconds).
          raw: {
            text: GOOD_RESPONSE,
            total_duration: 5_000_000,
            eval_duration: 4_000_000,
            prompt_eval_duration: 1_000_000,
            eval_count: 42,
            done_reason: "stop",
          },
        }))
      );
    } finally {
      cap.stop();
    }

    const done = cap.infos.find((a) => a[0] === "[rss-translation] item translated");
    assert.ok(done, "expected an 'item translated' log");
    const p = done![1] as Record<string, unknown>;
    assert.equal(typeof p.promptTokenEstimate, "number");
    assert.equal(typeof p.completionTokenEstimate, "number");
    // Nanoseconds are converted to whole milliseconds.
    assert.equal(p.ollamaTotalMs, 5);
    assert.equal(p.ollamaEvalMs, 4);
    assert.equal(p.ollamaPromptEvalMs, 1);
    assert.equal(p.ollamaEvalCount, 42);
    assert.equal(p.ollamaDoneReason, "stop");
  });

  it("omits Ollama metrics when the worker returns only text (no raw)", async () => {
    const db = makeDb();
    const cap = captureConsole();
    try {
      await translateFeedItem(
        makeItem(),
        "bg",
        makeDeps(db, async () => ({ text: GOOD_RESPONSE }))
      );
    } finally {
      cap.stop();
    }

    const done = cap.infos.find((a) => a[0] === "[rss-translation] item translated");
    const p = done![1] as Record<string, unknown>;
    assert.ok(!("ollamaTotalMs" in p), "no metrics key when the worker forwards none");
    assert.equal(typeof p.promptTokenEstimate, "number");
  });

  it("on an unparseable 200 reply logs the response SHAPE only — first/last 200 + length", async () => {
    // A middle marker proves the full body is never logged: with a >400-char reply, only the
    // first 200 and last 200 chars are captured, so anything in between must not appear.
    const db = makeDb();
    const MIDDLE = "MIDDLE_MARKER_MUST_NOT_LEAK";
    const unparseable =
      "Sorry, I cannot translate this. " +
      "a".repeat(220) +
      MIDDLE +
      "b".repeat(220) +
      " The end.";
    const cap = captureConsole();
    try {
      await translateFeedItem(
        makeItem(),
        "bg",
        makeDeps(db, async () => ({ text: unparseable }))
      );
    } finally {
      cap.stop();
    }

    const shape = cap.warns.find((a) => a[0] === "[rss-translation] unparseable model response");
    assert.ok(shape, "expected an 'unparseable model response' log");
    const payload = shape![1] as Record<string, unknown>;
    assert.equal(payload.responseLength, unparseable.length);
    assert.equal((payload.responseFirst200 as string).length, 200);
    assert.equal((payload.responseLast200 as string).length, 200);
    assert.match(payload.responseFirst200 as string, /^Sorry, I cannot translate/);
    assert.match(payload.error as string, /no JSON object/);
    // The bounded window excludes the middle of the reply — the full body is never logged.
    assert.ok(!cap.allText().includes(MIDDLE), "the middle of the response body must not be logged");
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
