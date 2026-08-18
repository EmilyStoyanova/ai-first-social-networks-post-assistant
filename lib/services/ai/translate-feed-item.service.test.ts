import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  translateFeedItem,
  type TranslatableItem,
  type TranslateFeedItemDeps,
} from "./translate-feed-item.service";
import {
  computeTranslationHash,
  MAX_TRANSLATION_ATTEMPTS,
  MAX_TRANSLATION_RETRIES,
} from "@/lib/ai/feed-item-translation";
import type { LlmRequest } from "@/lib/ai/types";

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
  translatedTitle: string | null;
  translatedContent: string | null;
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
    translatedTitle: null,
    translatedContent: null,
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
    get row() {
      return row;
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
  generate: (request: LlmRequest) => Promise<{ text: string; raw?: unknown }>,
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
      mode: "full",
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
    // The salvage CAN close an unterminated string, so what rejects this is length: 29
    // characters is a fragment, and the error says so rather than blaming the syntax.
    assert.match(outcome.status === "failed" ? outcome.error : "", /cut off after \d+ characters/i);
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
      "Sorry, I cannot translate this. " + "a".repeat(220) + MIDDLE + "b".repeat(220) + " The end.";
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

    const shape = cap.warns.find((a) => a[0] === "[rss-translation] unusable model response");
    assert.ok(shape, "expected an 'unusable model response' log");
    const payload = shape![1] as Record<string, unknown>;
    assert.equal(payload.responseLength, unparseable.length);
    assert.equal((payload.responseFirst200 as string).length, 200);
    assert.equal((payload.responseLast200 as string).length, 200);
    assert.match(payload.responseFirst200 as string, /^Sorry, I cannot translate/);
    assert.match(payload.error as string, /no JSON object/);
    // The bounded window excludes the middle of the reply — the full body is never logged.
    assert.ok(
      !cap.allText().includes(MIDDLE),
      "the middle of the response body must not be logged"
    );
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

// ─── Missing source text ──────────────────────────────────────────────────────

describe("translateFeedItem — no article body", () => {
  const EMPTY_BODIES: Array<string | null> = [null, "", "   \n\t "];

  it("never calls the model for an item with neither a title nor a body", async () => {
    for (const content of EMPTY_BODIES) {
      const db = makeDb();
      let calls = 0;
      const cap = captureConsole();
      let outcome;
      try {
        outcome = await translateFeedItem(
          makeItem({ title: null, content }),
          "bg",
          makeDeps(db, async () => {
            calls += 1;
            return { text: GOOD_RESPONSE };
          })
        );
      } finally {
        cap.stop();
      }

      assert.deepEqual(outcome, { status: "skipped", reason: "empty_source" });
      assert.equal(calls, 0, `content ${JSON.stringify(content)} must not reach the LLM`);
    }
  });

  it("spends ZERO model calls where it used to spend three", async () => {
    // The production symptom: articleTextLength 0 → three attempts, each rejected for a
    // missing "content", then a recorded failure and a backoff.
    const db = makeDb();
    let calls = 0;
    const cap = captureConsole();
    try {
      await translateFeedItem(
        makeItem({ title: null, content: null }),
        "bg",
        makeDeps(db, async () => {
          calls += 1;
          return { text: '{"title":"Заглавие","content":""}' };
        })
      );
    } finally {
      cap.stop();
    }

    assert.equal(calls, 0);
    assert.ok(
      !db.updates.some((u) => "translationAttemptCount" in u),
      "a source with no text must not burn one of the five cross-run attempts"
    );
  });

  it("settles the item terminally so it is never retried", async () => {
    const db = makeDb();
    const item = makeItem({ title: null, content: null });
    const cap = captureConsole();
    try {
      await translateFeedItem(
        item,
        "bg",
        makeDeps(db, async () => ({ text: GOOD_RESPONSE }))
      );
    } finally {
      cap.stop();
    }

    // "skipped" is not selectable by the translation cron, so there is no retry loop; the
    // stored hash means re-ingesting the same empty article changes nothing either.
    assert.equal(db.currentStatus, "skipped");
    assert.equal(db.row.translationHash, computeTranslationHash(null, null, "bg"));
    assert.equal(db.row.translationNextRetryAt, null);
    const final = db.updates.at(-1)!;
    assert.equal(final.translationError, null, "there is no error here — there was no article");
  });

  it("does not overwrite a completed translation of the same input", async () => {
    const hash = computeTranslationHash(null, null, "bg");
    const db = makeDb({ translationStatus: "completed", translationHash: hash });
    const cap = captureConsole();
    try {
      await translateFeedItem(
        makeItem({ title: null, content: null, translationStatus: "completed" }),
        "bg",
        makeDeps(db, async () => ({ text: GOOD_RESPONSE }))
      );
    } finally {
      cap.stop();
    }
    assert.equal(db.currentStatus, "completed");
  });

  it("says in the log why the item was skipped", async () => {
    const db = makeDb();
    const cap = captureConsole();
    try {
      await translateFeedItem(
        makeItem({ title: null, content: null }),
        "bg",
        makeDeps(db, async () => ({ text: GOOD_RESPONSE }))
      );
    } finally {
      cap.stop();
    }

    const line = cap.infos.find((a) =>
      String(a[0]).includes("[rss-translation] nothing to translate")
    );
    assert.ok(line, "expected a skip log naming the reason");
    const payload = line![1] as Record<string, unknown>;
    assert.equal(payload.reason, "empty_source");
    assert.equal(payload.articleTextLength, 0);
  });
});

describe("translateFeedItem — title-only items", () => {
  const TITLE_ONLY = { title: "Company launches new service", content: null };

  it("translates the title alone and stores no article body", async () => {
    const db = makeDb();
    const cap = captureConsole();
    let outcome;
    try {
      outcome = await translateFeedItem(
        makeItem(TITLE_ONLY),
        "bg",
        makeDeps(db, async () => ({ text: '{"title":"Компанията пуска нова услуга"}' }))
      );
    } finally {
      cap.stop();
    }

    assert.equal(outcome.status, "translated");
    assert.equal(outcome.status === "translated" && outcome.mode, "title_only");
    const final = db.updates.at(-1)!;
    assert.equal(final.translationStatus, "completed");
    assert.equal(final.translatedTitle, "Компанията пуска нова услуга");
    assert.equal(final.translatedContent, null, "an article with no body gets no body");
  });

  it("asks only for a title, so the model cannot be constrained into inventing one", async () => {
    const db = makeDb();
    const requests: LlmRequest[] = [];
    const cap = captureConsole();
    try {
      await translateFeedItem(
        makeItem(TITLE_ONLY),
        "bg",
        makeDeps(db, async (request) => {
          requests.push(request);
          return { text: '{"title":"Заглавие"}' };
        })
      );
    } finally {
      cap.stop();
    }

    assert.equal(requests.length, 1);
    const schema = requests[0].format as { required: string[] };
    assert.deepEqual(schema.required, ["title"], "a required `content` would force a fabrication");
    assert.ok(!requests[0].userPrompt.includes("Content:"));
  });

  it("discards an article body the model volunteered anyway", async () => {
    const db = makeDb();
    const cap = captureConsole();
    try {
      await translateFeedItem(
        makeItem(TITLE_ONLY),
        "bg",
        makeDeps(db, async () => ({
          text: '{"title":"Заглавие","content":"Съчинена статия, за която няма източник."}',
        }))
      );
    } finally {
      cap.stop();
    }

    assert.equal(db.row.translatedContent, null, "invented content must never be stored");
  });
});

// ─── Targeted retries ─────────────────────────────────────────────────────────

describe("translateFeedItem — retry feedback", () => {
  it("tells the model what was wrong instead of only re-rolling the sampling", async () => {
    const db = makeDb();
    const macedonian = JSON.stringify({
      title: "Компанијата објави нова услуга",
      content:
        "Компанијата денес објави дека новата услуга ќе биде достапна за сите корисници " +
        "во земјата, бидејќи цената останува иста за постојните претплатници.",
    });
    const p = scriptedProvider([macedonian, GOOD_RESPONSE]);
    const cap = captureConsole();
    let outcome;
    try {
      outcome = await translateFeedItem(makeItem(), "bg", makeDeps(db, p.generate));
    } finally {
      cap.stop();
    }

    assert.equal(outcome.status, "translated");
    assert.equal(p.requests.length, 2);
    // The first request is the plain translation; the second carries the correction.
    assert.ok(!p.requests[0].userPrompt.includes("REJECTED"));
    assert.match(p.requests[1].userPrompt, /YOUR PREVIOUS ANSWER WAS REJECTED/);
    assert.match(p.requests[1].userPrompt, /not Bulgarian/i);
    // The original article still travels with the correction.
    assert.match(p.requests[1].userPrompt, /Content: Original content/);
  });

  it("sends a JSON-specific correction after malformed JSON", async () => {
    const db = makeDb();
    const p = scriptedProvider(["Here you go: the translation is ready.", GOOD_RESPONSE]);
    const cap = captureConsole();
    try {
      await translateFeedItem(makeItem(), "bg", makeDeps(db, p.generate));
    } finally {
      cap.stop();
    }

    assert.match(p.requests[1].userPrompt, /not a single valid JSON object/i);
  });

  it("names the specific reason on every rejection log", async () => {
    const db = makeDb();
    const cap = captureConsole();
    try {
      await translateFeedItem(
        makeItem(),
        "bg",
        makeDeps(db, async () => ({ text: '{"title":"Заглавие","content":""}' }))
      );
    } finally {
      cap.stop();
    }

    const rejections = cap.warns.filter(
      (a) => a[0] === "[rss-translation] unusable model response"
    );
    assert.ok(rejections.length > 0);
    // An empty translation is its own reason, distinct from "the shape was wrong".
    assert.equal((rejections[0][1] as Record<string, unknown>).reason, "empty_translation");
    const failed = cap.warns.find((a) => a[0] === "[rss-translation] item translation FAILED");
    assert.equal((failed![1] as Record<string, unknown>).failureReason, "empty_translation");
  });

  it("keeps retries bounded — a permanently bad model costs one attempt, not five", async () => {
    const db = makeDb();
    const p = scriptedProvider(["never valid"]);
    const cap = captureConsole();
    try {
      await translateFeedItem(makeItem(), "bg", makeDeps(db, p.generate));
    } finally {
      cap.stop();
    }

    assert.equal(p.requests.length, MAX_TRANSLATION_RETRIES + 1);
    assert.equal(
      db.updates.filter((u) => "translationAttemptCount" in u).length,
      1,
      "the cross-run attempt is counted once, at claim time"
    );
    assert.ok((db.row.translationNextRetryAt as Date | null) !== null, "and a backoff is set");
  });
});

// ─── JSON salvage, end to end ─────────────────────────────────────────────────

describe("translateFeedItem — JSON salvage", () => {
  it("completes a reply wrapped in a <think> block instead of failing the item", async () => {
    const db = makeDb();
    const cap = captureConsole();
    let outcome;
    try {
      outcome = await translateFeedItem(
        makeItem(),
        "bg",
        makeDeps(db, async () => ({
          text: `<think>I should translate this into Bulgarian.</think>\n${GOOD_RESPONSE}`,
        }))
      );
    } finally {
      cap.stop();
    }

    assert.equal(outcome.status, "translated");
    const done = cap.infos.find((a) => a[0] === "[rss-translation] item translated");
    const payload = done![1] as Record<string, unknown>;
    assert.equal(payload.usedRepair, true);
    assert.deepEqual(payload.repairs, ["stripped_reasoning"], "the log says which salvage ran");
  });

  it("still fails safely on a reply too corrupted to read", async () => {
    const db = makeDb();
    const cap = captureConsole();
    let outcome;
    try {
      outcome = await translateFeedItem(
        makeItem(),
        "bg",
        makeDeps(db, async () => ({ text: '{"title":"Заглавие","content":"кратък' }))
      );
    } finally {
      cap.stop();
    }

    assert.equal(outcome.status, "failed");
    assert.ok(
      !db.updates.some((u) => "translatedContent" in u),
      "a fragment must never be stored as a completed translation"
    );
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

// ─── In-request regeneration (retries) ────────────────────────────────────────

/**
 * A provider double that returns a scripted reply per call and records the exact request it
 * received, so a test can assert BOTH the retry count and that each try actually varied its
 * sampling — a retry at an unchanged temperature 0 would deterministically reproduce the same
 * bad reply, which is the failure mode these retries exist to avoid. The last scripted reply
 * repeats for any further calls.
 */
function scriptedProvider(replies: string[]) {
  const requests: LlmRequest[] = [];
  return {
    requests,
    generate: async (request: LlmRequest) => {
      requests.push(request);
      return { text: replies[Math.min(requests.length - 1, replies.length - 1)] };
    },
  };
}

/** A well-formed, right-language reply whose body is a decoding loop ("със със със …"). */
const REPETITION_RESPONSE = `{"title":"Заглавие","content":"${"със ".repeat(40)}"}`;

describe("translateFeedItem — in-request retries", () => {
  it("regenerates after invalid JSON and succeeds on the second try", async () => {
    const db = makeDb();
    const p = scriptedProvider(["not json at all", GOOD_RESPONSE]);
    const cap = captureConsole();
    let outcome;
    try {
      outcome = await translateFeedItem(makeItem(), "bg", makeDeps(db, p.generate));
    } finally {
      cap.stop();
    }

    assert.equal(outcome.status, "translated");
    assert.equal(p.requests.length, 2, "expected exactly one regeneration");
    assert.equal(db.updates.at(-1)!.translatedContent, "Съдържание");
    // The cross-run attempt is counted ONCE (at claim time) however many retries it took.
    assert.equal(
      db.updates.filter((u) => "translationAttemptCount" in u).length,
      1,
      "in-request retries must not each burn a cross-run attempt"
    );
  });

  it("varies the sampling on each retry — an unchanged retry would fail identically", async () => {
    const db = makeDb();
    const p = scriptedProvider(["not json", "still not json", GOOD_RESPONSE]);
    const cap = captureConsole();
    try {
      await translateFeedItem(makeItem(), "bg", makeDeps(db, p.generate));
    } finally {
      cap.stop();
    }

    assert.equal(p.requests.length, 3);
    const temps = p.requests.map((r) => r.temperature);
    assert.equal(temps[0], 0, "the first try must stay deterministic for fidelity");
    assert.equal(
      new Set(temps).size,
      temps.length,
      `each try must use a distinct temperature, got ${JSON.stringify(temps)}`
    );
    const penalties = p.requests.map((r) => r.repeatPenalty as number);
    assert.ok(
      penalties.every((v, i) => i === 0 || v > penalties[i - 1]),
      `repeatPenalty must climb across retries, got ${JSON.stringify(penalties)}`
    );
    // Structured output stays constrained on every try, retries included.
    assert.ok(p.requests.every((r) => r.format !== undefined));
  });

  it("gives up after MAX_TRANSLATION_RETRIES regenerations and records one failure", async () => {
    const db = makeDb();
    const p = scriptedProvider(["never valid"]);
    const cap = captureConsole();
    let outcome;
    try {
      outcome = await translateFeedItem(makeItem(), "bg", makeDeps(db, p.generate));
    } finally {
      cap.stop();
    }

    assert.equal(outcome.status, "failed");
    assert.equal(
      p.requests.length,
      MAX_TRANSLATION_RETRIES + 1,
      "expected 1 initial call + MAX_TRANSLATION_RETRIES regenerations"
    );
    assert.equal(db.currentStatus, "failed");
    const failed = cap.warns.find((a) => a[0] === "[rss-translation] item translation FAILED");
    assert.equal((failed![1] as Record<string, unknown>).tries, MAX_TRANSLATION_RETRIES + 1);
  });

  it("regenerates a repetition loop and accepts the clean retry", async () => {
    const db = makeDb();
    const p = scriptedProvider([REPETITION_RESPONSE, GOOD_RESPONSE]);
    const cap = captureConsole();
    let outcome;
    try {
      outcome = await translateFeedItem(makeItem(), "bg", makeDeps(db, p.generate));
    } finally {
      cap.stop();
    }

    assert.equal(outcome.status, "translated");
    assert.equal(p.requests.length, 2);
    assert.equal(db.updates.at(-1)!.translatedContent, "Съдържание");

    const rejected = cap.warns.find((a) => a[0] === "[rss-translation] unusable model response");
    const payload = rejected![1] as Record<string, unknown>;
    assert.equal(payload.reason, "repetition");
    assert.equal(payload.repetitionKind, "repeated_word");
    assert.equal(payload.willRetry, true);
  });

  it("never stores a repetition loop when every try degenerates", async () => {
    const db = makeDb();
    const cap = captureConsole();
    let outcome;
    try {
      outcome = await translateFeedItem(
        makeItem(),
        "bg",
        makeDeps(db, async () => ({ text: REPETITION_RESPONSE }))
      );
    } finally {
      cap.stop();
    }

    assert.equal(outcome.status, "failed");
    for (const u of db.updates) {
      assert.ok(
        !("translatedContent" in u),
        "a degenerate translation must never be written to the item"
      );
    }
  });

  it("logs one concise attempt line per try", async () => {
    const db = makeDb();
    const cap = captureConsole();
    try {
      await translateFeedItem(
        makeItem(),
        "bg",
        makeDeps(db, scriptedProvider(["bad", GOOD_RESPONSE]).generate)
      );
    } finally {
      cap.stop();
    }

    const attempts = cap.infos.filter((a) => a[0] === "[rss-translation] attempt");
    assert.equal(attempts.length, 2);
    assert.equal((attempts[0][1] as Record<string, unknown>).try, 1);
    assert.equal((attempts[1][1] as Record<string, unknown>).try, 2);
    const done = cap.infos.find((a) => a[0] === "[rss-translation] item translated");
    assert.equal((done![1] as Record<string, unknown>).tries, 2);
  });
});

// ─── Shrinking retry after a truncated reply ──────────────────────────────────

/**
 * A long, clean English article — the shape of the ArchDaily bodies that truncated in
 * production. Comfortably over MAX_TRANSLATION_CONTENT_CHARS so the first try is capped at the
 * ceiling and a shrink is visible as a shorter prompt.
 */
const LONG_ARTICLE =
  "In the heart of Ahmedabad's Navrangpura district in India sits the Sardar Vallabhbhai " +
  "Patel Stadium, one of the country's earliest experiments in modernist public architecture. ";

/** The reply shape the logs showed: a body cut off mid-string, so the JSON never closes. */
const TRUNCATED_RESPONSE = `{"title":"Заглавие","content":"Частичен превод`;

/** The body characters the request actually carried, read back off the prompt. */
function bodyCharsOf(request: LlmRequest): number {
  const marker = "\nContent: ";
  const at = request.userPrompt.indexOf(marker);
  assert.ok(at !== -1, "expected a Content: section in the prompt");
  const rest = request.userPrompt.slice(at + marker.length);
  // A retry appends the correction after a "---" separator; the body ends there.
  const sep = rest.indexOf("\n\n---\n");
  return (sep === -1 ? rest : rest.slice(0, sep)).length;
}

describe("translateFeedItem — truncation shrinks the next try", () => {
  it("rebuilds the request with a smaller body after a cut-off reply", async () => {
    const db = makeDb();
    const p = scriptedProvider([TRUNCATED_RESPONSE, GOOD_RESPONSE]);
    const cap = captureConsole();
    let outcome;
    try {
      outcome = await translateFeedItem(
        makeItem({ content: LONG_ARTICLE.repeat(40) }),
        "bg",
        makeDeps(db, p.generate)
      );
    } finally {
      cap.stop();
    }

    assert.equal(outcome.status, "translated");
    assert.equal(p.requests.length, 2);

    const first = bodyCharsOf(p.requests[0]);
    const second = bodyCharsOf(p.requests[1]);
    assert.ok(
      second < first,
      `the retry must ask for less than the try that could not finish (${first} → ${second})`
    );
    // Halved, so the retry is a materially easier request rather than the same roll again.
    assert.ok(second <= first / 2 + 10, `expected roughly half of ${first}, got ${second}`);
  });

  it("does NOT shrink after a defect that a smaller article would not fix", async () => {
    const db = makeDb();
    // Wrong language: the model answered in English. Shortening the article changes nothing
    // about that, so the retry must keep the body it had and rely on the correction + sampling.
    const english =
      '{"title":"Modernism on the Watch","content":"The company announced today that the new ' +
      'service will be available next month across every major city in the country."}';
    const p = scriptedProvider([english, GOOD_RESPONSE]);
    const cap = captureConsole();
    try {
      await translateFeedItem(
        makeItem({ content: LONG_ARTICLE.repeat(40) }),
        "bg",
        makeDeps(db, p.generate)
      );
    } finally {
      cap.stop();
    }

    assert.equal(p.requests.length, 2);
    assert.equal(
      bodyCharsOf(p.requests[1]),
      bodyCharsOf(p.requests[0]),
      "a wrong_language retry must not lose article text"
    );
    const rejected = cap.warns.find((a) => a[0] === "[rss-translation] unusable model response");
    assert.equal((rejected![1] as Record<string, unknown>).reason, "wrong_language");
    assert.equal((rejected![1] as Record<string, unknown>).truncated, false);
  });

  it("keeps shrinking across tries and still stops at exactly 3 model calls", async () => {
    const db = makeDb();
    const p = scriptedProvider([TRUNCATED_RESPONSE]);
    const cap = captureConsole();
    let outcome;
    try {
      outcome = await translateFeedItem(
        makeItem({ content: LONG_ARTICLE.repeat(40) }),
        "bg",
        makeDeps(db, p.generate)
      );
    } finally {
      cap.stop();
    }

    // The retry BUDGET is untouched by the shrinking: 1 initial call + MAX_TRANSLATION_RETRIES.
    assert.equal(p.requests.length, 3);
    assert.equal(MAX_TRANSLATION_RETRIES + 1, 3, "the in-request budget is exactly 3 calls");
    assert.equal(outcome.status, "failed");

    const bodies = p.requests.map(bodyCharsOf);
    assert.ok(
      bodies[1] < bodies[0] && bodies[2] < bodies[1],
      `each truncation must shrink the next request, got ${JSON.stringify(bodies)}`
    );
    // One cross-run attempt, counted at claim time, however many in-request tries were spent.
    assert.equal(db.updates.filter((u) => "translationAttemptCount" in u).length, 1);
    assert.equal(db.currentStatus, "failed");
  });

  it("leaves sampling and the cross-run backoff exactly as they were", async () => {
    const db = makeDb();
    const p = scriptedProvider([TRUNCATED_RESPONSE]);
    const cap = captureConsole();
    let outcome;
    try {
      outcome = await translateFeedItem(
        makeItem({ content: LONG_ARTICLE.repeat(40) }),
        "bg",
        makeDeps(db, p.generate)
      );
    } finally {
      cap.stop();
    }

    // Sampling ladder: deterministic first, then distinct temperatures and a climbing penalty.
    const temps = p.requests.map((r) => r.temperature);
    assert.equal(temps[0], 0);
    assert.equal(new Set(temps).size, temps.length, JSON.stringify(temps));
    const penalties = p.requests.map((r) => r.repeatPenalty as number);
    assert.ok(
      penalties.every((v, i) => i === 0 || v > penalties[i - 1]),
      JSON.stringify(penalties)
    );
    // Structured output stays constrained on the shrunken retries too.
    assert.ok(p.requests.every((r) => r.format !== undefined));

    // Backoff: the first failed attempt is still scheduled 5 minutes out.
    assert.equal(outcome.status, "failed");
    if (outcome.status === "failed") {
      assert.equal(outcome.nextRetryAt.getTime() - NOW.getTime(), 5 * 60 * 1000);
    }
  });

  it("reports the shrink so an operator can see why the retry differed", async () => {
    const db = makeDb();
    const p = scriptedProvider([TRUNCATED_RESPONSE, GOOD_RESPONSE]);
    const cap = captureConsole();
    try {
      await translateFeedItem(
        makeItem({ content: LONG_ARTICLE.repeat(40) }),
        "bg",
        makeDeps(db, p.generate)
      );
    } finally {
      cap.stop();
    }

    const shrink = cap.infos.find(
      (a) => a[0] === "[rss-translation] shrinking article for the next try"
    );
    assert.ok(shrink, "expected a log line naming the smaller budget");
    const fields = shrink![1] as Record<string, unknown>;
    assert.equal(fields.contentBudget, 1500);
    assert.ok((fields.translatedBodyChars as number) <= 1504);

    const rejected = cap.warns.find((a) => a[0] === "[rss-translation] unusable model response");
    assert.equal((rejected![1] as Record<string, unknown>).truncated, true);
  });
});

// ─── Per-item timeout ─────────────────────────────────────────────────────────

/** A call that never settles — the hang the per-item budget exists to cut loose. */
const neverSettles = () => new Promise<{ text: string }>(() => {});

describe("translateFeedItem — timeout", () => {
  it("abandons a hung model call at its budget instead of hanging the batch", async () => {
    const db = makeDb();
    let calls = 0;
    const cap = captureConsole();
    let outcome;
    try {
      outcome = await translateFeedItem(makeItem(), "bg", {
        ...makeDeps(db, async () => {
          calls += 1;
          // The provider's own AbortSignal is 300s, so only the service's per-attempt
          // budget can return control to the batch here.
          return neverSettles();
        }),
        attemptTimeoutMs: 20,
      });
    } finally {
      cap.stop();
    }

    assert.equal(outcome.status, "failed");
    assert.match((outcome as { error: string }).error, /exceeded its 20ms budget/);
    assert.equal(calls, 1, "a timeout must not be retried in-request — the budget is spent");
    assert.equal(db.currentStatus, "failed");

    const failed = cap.warns.find((a) => a[0] === "[rss-translation] item translation FAILED");
    assert.equal((failed![1] as Record<string, unknown>).timedOut, true);
  });

  it("schedules a normal backoff after a timeout so the item is retried next run", async () => {
    const db = makeDb();
    const cap = captureConsole();
    let outcome;
    try {
      outcome = await translateFeedItem(makeItem(), "bg", {
        ...makeDeps(db, neverSettles),
        attemptTimeoutMs: 10,
      });
    } finally {
      cap.stop();
    }

    assert.equal(outcome.status, "failed");
    // First failed attempt → the 5-minute step of the shared backoff schedule.
    assert.deepEqual(
      (outcome as { nextRetryAt: Date }).nextRetryAt,
      new Date(NOW.getTime() + 5 * 60 * 1000)
    );
  });

  it("bounds the item by an injected budget below its own default", async () => {
    // The batch squeezes this down to whatever the run has left, so one article cannot
    // carry the run past the route's cap. The item budget must actually bite.
    const db = makeDb();
    const cap = captureConsole();
    let outcome;
    try {
      outcome = await translateFeedItem(makeItem(), "bg", {
        ...makeDeps(db, neverSettles),
        attemptTimeoutMs: 5_000,
        itemTimeoutMs: 15,
      });
    } finally {
      cap.stop();
    }

    assert.equal(outcome.status, "failed");
    assert.match((outcome as { error: string }).error, /exceeded its (15|5000)ms budget/);
  });

  it("does not let a hung item stop the next item from translating", async () => {
    // The batch-level guarantee seen through the service: the hung item resolves to a
    // recorded failure, so the caller's loop proceeds instead of blocking on the socket.
    const slowDb = makeDb();
    const slow = await translateFeedItem(makeItem({ id: "slow" }), "bg", {
      ...makeDeps(slowDb, neverSettles),
      attemptTimeoutMs: 10,
    });
    const fastDb = makeDb();
    const fast = await translateFeedItem(
      makeItem({ id: "fast" }),
      "bg",
      makeDeps(fastDb, async () => ({ text: GOOD_RESPONSE }))
    );

    assert.equal(slow.status, "failed");
    assert.equal(fast.status, "translated");
  });
});
