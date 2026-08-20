import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { translateFeedItem } from "./translate-feed-item.service";
import type { TranslateFeedItemDb, TranslatableItem } from "./translate-feed-item.service";
import { computeTranslationHash } from "@/lib/ai/feed-item-translation";
import { GenerationTracer } from "@/lib/generation-trace/tracer";
import type { PersistableRun } from "@/lib/generation-trace/store";

/**
 * The whole path, with `TRANSLATION_PROVIDER=madlad`, from the cron's point of view:
 *
 *   translateFeedItem → factory → MadladTranslationProvider → POST /translate
 *                     → quality gate → the row that generation later reads.
 *
 * Nothing here touches the Mac, the network or the database — `fetch` is stubbed and
 * the DB is the same conditional-update double the sibling suite uses. The engine is
 * selected through an INJECTED environment, so this file cannot change what any other
 * test in the run sees.
 *
 * Four outcomes are pinned, because they are the four an operator will actually meet:
 * a good translation is stored; a bad translation FAILS the item (it is never handed
 * to another engine); a dead worker fails the item when no fallback is configured; and
 * a dead worker falls through to Qwen when — and only when — one is.
 */

// ─── Doubles ──────────────────────────────────────────────────────────────────

const NOW = new Date("2026-08-19T09:00:00.000Z");

const WORKER_ENV = {
  TEXT_WORKER_URL: "http://192.168.31.102:3002",
  TEXT_WORKER_API_KEY: "secret",
  TRANSLATION_PROVIDER: "madlad",
};

function makeDb() {
  const updates: Record<string, unknown>[] = [];
  const db: TranslateFeedItemDb = {
    feedItem: {
      update: async (args) => {
        updates.push(args.data);
        return {};
      },
      // Grants the atomic claim and the guarded failure write alike — concurrency is
      // the sibling suite's subject, not this one's.
      updateMany: async (args) => {
        updates.push(args.data);
        return { count: 1 };
      },
    },
  };
  return { db, updates, last: () => updates.at(-1)! };
}

function makeItem(overrides: Partial<TranslatableItem> = {}): TranslatableItem {
  return {
    id: "item-1",
    companyId: "company-1",
    title: "How long do fire extinguishers last?",
    content:
      "A fire extinguisher can last between 5 and 15 years.\n\nCheck the pressure gauge once a month.",
    url: "https://example.com/extinguishers",
    translationStatus: "pending",
    translationHash: null,
    translationAttemptCount: 0,
    ...overrides,
  };
}

/** The admin default LLM — the fallback engine, and the one MADLAD must never consult. */
function makeLlm(text: string) {
  let calls = 0;
  return {
    calls: () => calls,
    resolve: async () => ({
      ok: true as const,
      provider: "TEXT_WORKER",
      model: "qwen3:8b",
      instance: {
        generate: async () => {
          calls += 1;
          return { text };
        },
      },
    }),
  };
}

const QWEN_REPLY = JSON.stringify({
  title: "Колко издържат пожарогасителите?",
  content: "Пожарогасителят издържа между 5 и 15 години.",
});

/** A trace step's metadata, typed for reading — the store's own type is opaque JSON. */
const meta = (run: PersistableRun, type: string): Record<string, unknown> =>
  (run.steps.find((s) => s.type === type)?.metadata ?? {}) as Record<string, unknown>;

const realFetch = globalThis.fetch;
let requests: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] =
  [];

function stubWorker(handler: (text: string, call: number) => Response) {
  let call = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push({
      url: String(input),
      body,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    call += 1;
    return handler(String(body.text), call);
  }) as typeof fetch;
}

/** A well-formed MADLAD reply. */
function madlad(text: string, status = 200): Response {
  return new Response(
    JSON.stringify({ text, provider: "madlad", model: "google/madlad400-3b-mt", durationMs: 400 }),
    { status, headers: { "content-type": "application/json" } }
  );
}

const BULGARIAN = [
  "Колко издържат пожарогасителите?",
  "Пожарогасителят издържа между 5 и 15 години.",
  "Проверявайте манометъра веднъж месечно.",
];

beforeEach(() => {
  requests = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ─── The accepted path ────────────────────────────────────────────────────────

describe("translateFeedItem with TRANSLATION_PROVIDER=madlad", () => {
  it("translates through POST /translate and stores the result", async () => {
    const { db, last } = makeDb();
    const llm = makeLlm(QWEN_REPLY);
    stubWorker((_text, call) => madlad(BULGARIAN[call - 1]));

    const item = makeItem();
    const outcome = await translateFeedItem(item, "bg", {
      db,
      now: () => NOW,
      env: WORKER_ENV,
      resolveProvider: llm.resolve,
    });

    assert.deepEqual(outcome, {
      status: "translated",
      provider: "TEXT_WORKER",
      model: "google/madlad400-3b-mt",
      mode: "full",
    });

    const final = last();
    assert.equal(final.translationStatus, "completed");
    assert.equal(final.translatedTitle, BULGARIAN[0]);
    assert.equal(final.translatedContent, `${BULGARIAN[1]}\n\n${BULGARIAN[2]}`);
    assert.equal(final.translationModel, "google/madlad400-3b-mt");
    assert.equal(final.translationProvider, "TEXT_WORKER");
    assert.equal(final.translationHash, computeTranslationHash(item.title, item.content, "bg"));
    assert.equal(final.translationError, null);
  });

  it("hits /translate, not /generate, and never asks the LLM anything", async () => {
    const { db } = makeDb();
    const llm = makeLlm(QWEN_REPLY);
    stubWorker((_text, call) => madlad(BULGARIAN[call - 1]));

    await translateFeedItem(makeItem(), "bg", {
      db,
      now: () => NOW,
      env: WORKER_ENV,
      resolveProvider: llm.resolve,
    });

    assert.ok(requests.length > 0);
    assert.ok(
      requests.every((r) => r.url.endsWith("/translate")),
      "the whole point of the engine switch is which endpoint is called"
    );
    assert.equal(llm.calls(), 0, "MADLAD must not run through an LlmConfig row");
    assert.deepEqual(Object.keys(requests[0].body).sort(), [
      "sourceLanguage",
      "targetLanguage",
      "text",
    ]);
  });

  it("does NOT use MADLAD when the variable is absent — the default is unchanged", async () => {
    const { db, last } = makeDb();
    const llm = makeLlm(QWEN_REPLY);
    stubWorker(() => madlad("никога"));

    const outcome = await translateFeedItem(makeItem(), "bg", {
      db,
      now: () => NOW,
      env: { ...WORKER_ENV, TRANSLATION_PROVIDER: undefined },
      resolveProvider: llm.resolve,
    });

    assert.equal(outcome.status, "translated");
    assert.equal(requests.length, 0, "no /translate call may be made on the default path");
    assert.equal(llm.calls(), 1);
    assert.equal(last().translationModel, "qwen3:8b");
  });

  it("names the engine, the provider and the model in the trace", async () => {
    const runs: PersistableRun[] = [];
    const tracer = GenerationTracer.start({
      kind: "translation",
      trigger: "system",
      feedItemId: "item-1",
      store: { saveRun: async (run) => void runs.push(run) },
      newId: () => "run-madlad",
    });
    stubWorker((_text, call) => madlad(BULGARIAN[call - 1]));

    await translateFeedItem(makeItem(), "bg", {
      db: makeDb().db,
      now: () => NOW,
      env: WORKER_ENV,
      tracer,
      resolveProvider: makeLlm(QWEN_REPLY).resolve,
    });

    const run = runs[0];
    assert.equal(run.llmProvider, "TEXT_WORKER");
    assert.equal(run.llmModel, "google/madlad400-3b-mt");

    assert.equal(meta(run, "request").translationEngine, "madlad");
    assert.equal(meta(run, "request").translationProvider, "TEXT_WORKER");
    assert.equal(meta(run, "request").translationModel, "google/madlad400-3b-mt");

    // Cost, in the units this engine actually spends it in.
    assert.equal(meta(run, "persistence").engine, "madlad");
    assert.equal(meta(run, "persistence").tries, 1);
    assert.equal(meta(run, "persistence").modelCalls, 3);
    assert.equal(meta(run, "persistence").fallbackUsed, false);

    assert.equal(meta(run, "llm_call").workerCalls, 3);
    assert.equal(meta(run, "llm_call").segmentCount, 3);
  });
});

// ─── Rejection: the quality gate, and what it must NOT trigger ────────────────

describe("translateFeedItem with MADLAD — a bad translation", () => {
  it("fails the item when the output is not Bulgarian", async () => {
    const { db, last } = makeDb();
    // The worker answers, in good faith, with the English it was given.
    stubWorker((text) => madlad(text));

    const outcome = await translateFeedItem(makeItem(), "bg", {
      db,
      now: () => NOW,
      env: WORKER_ENV,
      resolveProvider: makeLlm(QWEN_REPLY).resolve,
    });

    assert.equal(outcome.status, "failed");
    assert.match(outcome.status === "failed" ? outcome.error : "", /not Bulgarian/);
    assert.equal(last().translationStatus, "failed");
    assert.ok(last().translationNextRetryAt instanceof Date, "it is retried on the next run");
  });

  it("never falls back on a bad translation, even with the fallback enabled", async () => {
    // The distinction the whole trial rests on: a poor translation is MADLAD's ANSWER.
    // Swapping engines behind it would make the two indistinguishable in the data.
    const llm = makeLlm(QWEN_REPLY);
    stubWorker((text) => madlad(text));

    const outcome = await translateFeedItem(makeItem(), "bg", {
      db: makeDb().db,
      now: () => NOW,
      env: { ...WORKER_ENV, TRANSLATION_MADLAD_FALLBACK: "ollama" },
      resolveProvider: llm.resolve,
    });

    assert.equal(outcome.status, "failed");
    assert.equal(llm.calls(), 0, "a quality rejection is not a technical failure");
  });

  it("spends exactly one attempt — a beam-search retry would reproduce the answer", async () => {
    stubWorker((text) => madlad(text));

    await translateFeedItem(makeItem(), "bg", {
      db: makeDb().db,
      now: () => NOW,
      env: WORKER_ENV,
      resolveProvider: makeLlm(QWEN_REPLY).resolve,
    });

    // Three segments, one pass. No second pass over the article.
    assert.equal(requests.length, 3);
  });
});

// ─── Technical failure: the only thing a fallback may ever answer ─────────────

describe("translateFeedItem with MADLAD — a technical failure", () => {
  it("fails the item when the worker is down and no fallback is configured", async () => {
    const llm = makeLlm(QWEN_REPLY);
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    const outcome = await translateFeedItem(makeItem(), "bg", {
      db: makeDb().db,
      now: () => NOW,
      env: WORKER_ENV,
      resolveProvider: llm.resolve,
    });

    assert.equal(outcome.status, "failed");
    assert.match(outcome.status === "failed" ? outcome.error : "", /unreachable/);
    assert.equal(llm.calls(), 0, "fallback is off unless explicitly asked for");
  });

  it("falls back to the prompt-based engine when TRANSLATION_MADLAD_FALLBACK=ollama", async () => {
    const { db, last } = makeDb();
    const llm = makeLlm(QWEN_REPLY);
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    const outcome = await translateFeedItem(makeItem(), "bg", {
      db,
      now: () => NOW,
      env: { ...WORKER_ENV, TRANSLATION_MADLAD_FALLBACK: "ollama" },
      resolveProvider: llm.resolve,
    });

    assert.equal(outcome.status, "translated");
    assert.equal(llm.calls(), 1);
    // Provenance follows the engine that actually produced the text.
    assert.equal(outcome.status === "translated" ? outcome.model : "", "qwen3:8b");
    assert.equal(last().translationModel, "qwen3:8b");
    assert.equal(last().translatedTitle, "Колко издържат пожарогасителите?");
  });

  it("also falls back on a non-2xx and on a foreign envelope", async () => {
    for (const bad of [
      () => madlad("боклук", 503),
      () =>
        new Response(JSON.stringify({ text: "Текст на български език тук.", provider: "ollama" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ]) {
      const llm = makeLlm(QWEN_REPLY);
      stubWorker(bad);

      const outcome = await translateFeedItem(makeItem(), "bg", {
        db: makeDb().db,
        now: () => NOW,
        env: { ...WORKER_ENV, TRANSLATION_MADLAD_FALLBACK: "ollama" },
        resolveProvider: llm.resolve,
      });

      assert.equal(outcome.status, "translated");
      assert.equal(llm.calls(), 1);
    }
  });

  it("records the fallback in the trace, so no run's provenance is a guess", async () => {
    const runs: PersistableRun[] = [];
    const tracer = GenerationTracer.start({
      kind: "translation",
      trigger: "system",
      feedItemId: "item-1",
      store: { saveRun: async (run) => void runs.push(run) },
      newId: () => "run-fallback",
    });
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    await translateFeedItem(makeItem(), "bg", {
      db: makeDb().db,
      now: () => NOW,
      env: { ...WORKER_ENV, TRANSLATION_MADLAD_FALLBACK: "ollama" },
      tracer,
      resolveProvider: makeLlm(QWEN_REPLY).resolve,
    });

    const run = runs[0];
    const retry = run.steps.find((s) => s.type === "retry");
    const output = retry?.output as { fallbackUsed: boolean; from: string; to: string };
    assert.equal(output.fallbackUsed, true);
    assert.match(output.from, /madlad/);
    assert.match(output.to, /ollama/);

    assert.equal(meta(run, "persistence").fallbackUsed, true);
    // The run's own provenance is the engine that produced the stored text.
    assert.equal(run.llmModel, "qwen3:8b");
  });
});

// ─── Configuration ────────────────────────────────────────────────────────────

describe("translateFeedItem with MADLAD — configuration", () => {
  it("reports no_provider, and burns no attempt, when the worker is unconfigured", async () => {
    const { db, updates } = makeDb();
    const llm = makeLlm(QWEN_REPLY);

    const outcome = await translateFeedItem(makeItem(), "bg", {
      db,
      now: () => NOW,
      env: { TRANSLATION_PROVIDER: "madlad" },
      resolveProvider: llm.resolve,
    });

    assert.deepEqual(outcome, { status: "no_provider" });
    assert.equal(updates.length, 0, "an operator problem must not cost the article an attempt");
    assert.equal(llm.calls(), 0, "and must not quietly translate with the other engine");
  });

  it("honours TRANSLATION_MADLAD_MODEL in what it stores", async () => {
    const { db, last } = makeDb();
    stubWorker(
      (_text, call) =>
        new Response(
          JSON.stringify({
            text: BULGARIAN[call - 1],
            provider: "madlad",
            model: "google/madlad400-10b-mt",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );

    await translateFeedItem(makeItem(), "bg", {
      db,
      now: () => NOW,
      env: { ...WORKER_ENV, TRANSLATION_MADLAD_MODEL: "google/madlad400-10b-mt" },
      resolveProvider: makeLlm(QWEN_REPLY).resolve,
    });

    assert.equal(last().translationModel, "google/madlad400-10b-mt");
  });
});
