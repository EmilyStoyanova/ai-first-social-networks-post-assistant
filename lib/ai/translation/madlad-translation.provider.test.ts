import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MadladTranslationProvider } from "./madlad-translation.provider";
import { TranslationTransportError } from "./translation-provider";
import type { ArticleTranslationContext, TranslationProvider } from "./translation-provider";
import { MAX_REPAIRS_PER_ARTICLE, maxRepairsFor, MIN_REPAIR_BUDGET_MS } from "./segment-repair";
import { TranslationTimeoutError } from "./translation-timeout";
import { buildTranslationPrompts, TranslationParseError } from "@/lib/ai/feed-item-translation";
import { GenerationTracer } from "@/lib/generation-trace/tracer";
import type { PersistableRun } from "@/lib/generation-trace/store";

/**
 * The wire contract asserted here is the one the RUNNING Mac worker implements
 * (text-worker commit d829fec): a BATCH per call, `{ texts, sourceLanguage,
 * targetLanguage }` in and `{ texts, provider, model, durationMs }` out, in the same
 * order. Nothing here talks to a real worker.
 *
 * The split down the middle of this file is the important one: a bad TRANSLATION is a
 * TranslationParseError (the engine answered; the answer was unusable), while a bad
 * REPLY is a TranslationTransportError (the engine did not answer in the agreed shape).
 * Only the second class may ever fall back to another engine, so the two must never
 * collapse into one.
 */

// ─── fetch stubbing ───────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
let requests: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] =
  [];

function stubFetch(handler: (body: Record<string, unknown>) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push({
      url: String(input),
      body,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return handler(body);
  }) as typeof fetch;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A well-formed BATCH worker reply carrying `texts`, in request order. */
function reply(texts: string[], extra: Record<string, unknown> = {}): Response {
  return json({
    texts,
    provider: "madlad",
    model: "google/madlad400-3b-mt",
    durationMs: 412,
    ...extra,
  });
}

const bodyTexts = (body: Record<string, unknown>): string[] => (body.texts as string[]) ?? [];

/** Answers every segment in the batch with plausible, distinct Bulgarian. */
let counter = 0;
function translated(body: Record<string, unknown>): Response {
  return reply(
    bodyTexts(body).map(() => {
      counter += 1;
      return `Преведен сегмент ${counter} на български език.`;
    })
  );
}

beforeEach(() => {
  requests = [];
  counter = 0;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TITLE = "How long do fire extinguishers last?";
const CONTENT = "A fire extinguisher can last between 5 and 15 years.\n\nCheck the pressure gauge.";

function contextFor(overrides: Partial<ArticleTranslationContext> = {}): ArticleTranslationContext {
  return {
    tracer: GenerationTracer.disabled(),
    now: () => new Date(),
    diag: {},
    attemptTimeoutMs: 60_000,
    itemDeadlineMs: Date.now() + 120_000,
    itemTimeoutMs: 120_000,
    ...overrides,
  };
}

function requestFor(title: string | null, content: string | null) {
  const prompts = buildTranslationPrompts(title, content, "bg");
  return {
    feedItemId: "item-1",
    url: "https://example.com/a",
    title,
    content,
    targetLang: "bg",
    mode: prompts.mode,
    prompts,
  };
}

/** Default provider — httpBatchSize defaults to 30, comfortably above every fixture here. */
function provider() {
  return new MadladTranslationProvider(
    "http://192.168.31.102:3002/",
    "secret-key",
    "google/madlad400-3b-mt"
  );
}

// ─── The request ──────────────────────────────────────────────────────────────

describe("MadladTranslationProvider — the request", () => {
  it("posts to /translate on the EXISTING worker, with the worker's own API key", async () => {
    stubFetch(translated);
    await provider().translate(requestFor(TITLE, CONTENT), contextFor());

    // The trailing slash on the base URL must not become a double slash.
    assert.equal(requests[0].url, "http://192.168.31.102:3002/translate");
    assert.equal(requests[0].headers["x-worker-api-key"], "secret-key");
    assert.equal(requests[0].headers["content-type"], "application/json");
  });

  it("sends exactly texts + sourceLanguage + targetLanguage, and nothing else", async () => {
    stubFetch(translated);
    await provider().translate(requestFor(TITLE, null), contextFor());

    assert.deepEqual(requests[0].body, {
      texts: [TITLE],
      sourceLanguage: "en",
      targetLanguage: "bg",
    });
  });

  it("sends every segment that fits under the batch size in ONE HTTP call, in document order", async () => {
    stubFetch(translated);
    await provider().translate(requestFor(TITLE, CONTENT), contextFor());

    assert.equal(requests.length, 1, "title + two paragraphs all fit under the default batch size");
    assert.deepEqual(requests[0].body.texts, [
      TITLE,
      "A fire extinguisher can last between 5 and 15 years.",
      "Check the pressure gauge.",
    ]);
  });

  it("sends only the title for a bodyless article", async () => {
    stubFetch(translated);
    await provider().translate(requestFor(TITLE, null), contextFor());

    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].body.texts, [TITLE]);
  });

  it("honours an explicit source language", async () => {
    stubFetch(translated);
    const p = new MadladTranslationProvider("http://w:3002", "k", "google/madlad400-3b-mt", "de");
    await p.translate(requestFor(TITLE, null), contextFor());

    assert.equal(requests[0].body.sourceLanguage, "de");
  });
});

// ─── Attempts versus calls ────────────────────────────────────────────────────

describe("MadladTranslationProvider — attempts versus calls", () => {
  it("spends exactly ONE attempt — beam search would only reproduce a bad result", async () => {
    stubFetch(translated);
    const result = await provider().translate(requestFor(TITLE, CONTENT), contextFor());

    assert.equal(result.tries, 1);
    assert.equal(provider().maxTries, 1);
  });

  it("reports the HTTP calls separately, because one attempt can be many BATCHES", async () => {
    stubFetch(translated);
    // httpBatchSize 2: 3 segments (title + 2 paragraphs) split into batches of [2, 1].
    const p = new MadladTranslationProvider(
      "http://w:3002",
      "k",
      "google/madlad400-3b-mt",
      "en",
      1,
      2
    );
    const result = await p.translate(requestFor(TITLE, CONTENT), contextFor());

    assert.equal(requests.length, 2);
    assert.equal(
      result.modelCalls,
      2,
      "modelCalls is the true HTTP request count, not the segment count"
    );
    assert.notEqual(result.modelCalls, result.tries, "conflating the two hides the real cost");
  });

  it("reports the attempt to the caller before the first call", async () => {
    const seen: number[] = [];
    stubFetch(translated);
    await provider().translate(
      requestFor(TITLE, CONTENT),
      contextFor({ reportTry: (n) => void seen.push(n) })
    );
    assert.deepEqual(seen, [1]);
  });
});

// ─── The reply ────────────────────────────────────────────────────────────────

describe("MadladTranslationProvider — the reply", () => {
  it("reassembles the segments into a title and a paragraphed body", async () => {
    stubFetch(translated);
    const result = await provider().translate(requestFor(TITLE, CONTENT), contextFor());

    assert.equal(result.translatedTitle, "Преведен сегмент 1 на български език.");
    assert.equal(
      result.translatedContent,
      "Преведен сегмент 2 на български език.\n\nПреведен сегмент 3 на български език."
    );
  });

  it("stores no body for a title-only article, whatever the worker returned", async () => {
    stubFetch(translated);
    const result = await provider().translate(requestFor(TITLE, null), contextFor());

    assert.equal(result.translatedContent, null);
    assert.ok(result.translatedTitle);
  });

  it("never reports a JSON repair — there is no JSON to repair", async () => {
    stubFetch(translated);
    const result = await provider().translate(requestFor(TITLE, CONTENT), contextFor());

    assert.equal(result.usedRepair, false);
    assert.deepEqual(result.repairs, []);
  });

  it("carries the worker's own duration and device through for the trace — one batch, one durationMs", async () => {
    stubFetch((body) =>
      reply(
        bodyTexts(body).map(() => "Преведен текст на български език."),
        { device: "mps", durationMs: 100 }
      )
    );
    const result = await provider().translate(requestFor(TITLE, CONTENT), contextFor());

    assert.deepEqual(result.raw, {
      provider: "madlad",
      model: "google/madlad400-3b-mt",
      device: "mps",
      durationMs: 100,
      translatedSegments: 3,
      httpBatchSize: 30,
      workerRequests: 1,
      protectedTokens: 0,
      bypassedDataOnlySegments: 0,
      bypassedDataOnlyIndices: [],
      // A healthy article reports the repair counters as ZERO rather than omitting
      // them, so "no segment needed repair" and "this payload predates repair" are
      // distinguishable in stored data instead of both reading as an absent field.
      repairedSegments: 0,
      fallbackToOriginalSegments: 0,
      repairedSegmentIndices: [],
      fallbackSegmentIndices: [],
      repairProvider: null,
      repairModel: null,
      repairFailureReasons: [],
    });
  });

  it("sums duration ACROSS batches when more than one HTTP call was made", async () => {
    stubFetch((body) =>
      reply(
        bodyTexts(body).map(() => "Преведен текст на български език."),
        { device: "mps", durationMs: 100 }
      )
    );
    const p = new MadladTranslationProvider(
      "http://w:3002",
      "k",
      "google/madlad400-3b-mt",
      "en",
      1,
      2
    );
    const result = await p.translate(requestFor(TITLE, CONTENT), contextFor());

    assert.equal(requests.length, 2, "3 segments at batch size 2 -> two HTTP calls");
    assert.equal(
      (result.raw as { durationMs: number }).durationMs,
      200,
      "100ms per batch, 2 batches"
    );
    assert.equal((result.raw as { workerRequests: number }).workerRequests, 2);
  });

  it("records the segment and batch counts on the trace", async () => {
    const runs: PersistableRun[] = [];
    const tracer = GenerationTracer.start({
      kind: "translation",
      trigger: "system",
      store: { saveRun: async (run) => void runs.push(run) },
      newId: () => "run-madlad",
    });

    stubFetch(translated);
    await provider().translate(requestFor(TITLE, CONTENT), contextFor({ tracer }));
    await tracer.flush();

    const meta = (type: string): Record<string, unknown> =>
      (runs[0].steps.find((s) => s.type === type)?.metadata ?? {}) as Record<string, unknown>;

    assert.equal(meta("llm_call").segmentCount, 3);
    assert.equal(meta("llm_call").httpBatchSize, 30);
    assert.equal(meta("llm_call").workerRequests, 1);
    // The engine's own name, on the step that shows what was sent.
    assert.equal(meta("prompt").engine, "madlad");
    assert.equal(meta("prompt").model, "google/madlad400-3b-mt");
  });
});

// ─── Protected values: URLs must survive the round trip ──────────────────────

const URL_A = "https://example.com/safety/extinguisher-checklist";
const URL_B = "https://example.com/b";

/** Answers in Bulgarian, echoing back whatever placeholders each segment was given. */
function echoing(body: Record<string, unknown>): Response {
  return reply(
    bodyTexts(body).map((text) => {
      const holders = text.match(/\[\[\d+\]\]/g) ?? [];
      return holders.length > 0
        ? `Преведено изречение с ${holders.join(" и ")} на български език.`
        : "Преведено изречение на български език.";
    })
  );
}

describe("MadladTranslationProvider — protected values", () => {
  it("never sends a raw URL to the model — it would be translated or deleted", async () => {
    stubFetch(echoing);
    await provider().translate(
      requestFor("Заглавие", `Full inspection guidance is published at ${URL_A} today.`),
      contextFor()
    );

    for (const request of requests) {
      const sent = bodyTexts(request.body).join(" ");
      assert.ok(!sent.includes("example.com"), `a raw URL reached the model: ${sent}`);
    }
    assert.ok(requests.some((r) => bodyTexts(r.body).some((t) => t.includes("[[0]]"))));
  });

  it("restores the URL exactly into the stored translation", async () => {
    stubFetch(echoing);
    const result = await provider().translate(
      requestFor("Заглавие", `Full inspection guidance is published at ${URL_A} today.`),
      contextFor()
    );

    assert.ok(result.translatedContent?.includes(URL_A), result.translatedContent ?? "(null)");
  });

  it("keeps two different URLs distinct and in order", async () => {
    stubFetch(echoing);
    const result = await provider().translate(
      requestFor("Заглавие", `See ${URL_A} and ${URL_B} for details.`),
      contextFor()
    );

    const found = result.translatedContent?.match(/https:\/\/\S+/g) ?? [];
    assert.deepEqual(
      found.map((u) => u.replace(/[.,]$/, "")),
      [URL_A, URL_B]
    );
  });

  it("keeps a duplicated URL duplicated", async () => {
    stubFetch(echoing);
    const result = await provider().translate(
      requestFor("Заглавие", `Both ${URL_A} and ${URL_A} point to the same page.`),
      contextFor()
    );

    const found = (result.translatedContent ?? "").split(URL_A).length - 1;
    assert.equal(found, 2);
  });

  it("counts the protected values in the result metrics", async () => {
    stubFetch(echoing);
    const result = await provider().translate(
      requestFor("Заглавие", `See ${URL_A} and ${URL_B} for details.`),
      contextFor()
    );

    assert.equal((result.raw as { protectedTokens: number }).protectedTokens, 2);
  });

  it("restores protected values correctly across MULTIPLE batches, each isolated to its own segment", async () => {
    const URL_C = "https://example.com/c";
    stubFetch(echoing);
    // httpBatchSize 1 forces each sentence into its own HTTP call — the strictest test
    // that per-segment protected values never leak across a batch boundary.
    const p = new MadladTranslationProvider(
      "http://w:3002",
      "k",
      "google/madlad400-3b-mt",
      "en",
      1,
      1
    );
    const result = await p.translate(
      requestFor(null, `Read ${URL_A} today. Visit ${URL_B} next. See ${URL_C} also.`),
      contextFor()
    );

    assert.equal(requests.length, 3, "one HTTP call per segment at batch size 1");
    const found = result.translatedContent?.match(/https:\/\/\S+/g) ?? [];
    assert.deepEqual(
      found.map((u) => u.replace(/[.,]$/, "")),
      [URL_A, URL_B, URL_C],
      "each URL must land back in ITS OWN sentence, in source order"
    );
  });

  it("REJECTS a translation that dropped a placeholder — no silent URL loss", async () => {
    // Exactly what the first real benchmark produced, before the placeholders existed:
    // a fluent Bulgarian sentence with the URL simply gone. Title + one body segment.
    stubFetch(() => reply(["Заглавие", "Пълните указания за проверка са публикувани на адрес."]));

    await assert.rejects(
      provider().translate(
        requestFor("Заглавие", `Full inspection guidance is published at ${URL_A} today.`),
        contextFor()
      ),
      (err: unknown) => err instanceof TranslationParseError && err.reason === "protected_token"
    );
  });

  it("REJECTS a translation that duplicated a placeholder", async () => {
    stubFetch(() => reply(["Заглавие", "Указанията са на [[0]] и на [[0]] едновременно."]));

    await assert.rejects(
      provider().translate(
        requestFor("Заглавие", `Guidance is published at ${URL_A} today.`),
        contextFor()
      ),
      (err: unknown) => err instanceof TranslationParseError && err.reason === "protected_token"
    );
  });

  it("REJECTS a translation that mangled a placeholder", async () => {
    stubFetch(() => reply(["Заглавие", "Указанията са публикувани на __ днес и още нещо."]));

    await assert.rejects(
      provider().translate(
        requestFor("Заглавие", `Guidance is published at ${URL_A} today.`),
        contextFor()
      ),
      (err: unknown) => err instanceof TranslationParseError && err.reason === "protected_token"
    );
  });

  it("REJECTS an invented URL that was never in the source", async () => {
    // The article-level invariant, independent of per-segment restoration: the model
    // hallucinated a URL of its own into an article that had none.
    stubFetch((body) =>
      reply(bodyTexts(body).map(() => "Вижте https://spam.example.net/x за повече информация."))
    );

    await assert.rejects(
      provider().translate(requestFor(TITLE, CONTENT), contextFor()),
      (err: unknown) => err instanceof TranslationParseError && err.reason === "protected_token"
    );
  });

  it("judges the language on the PLACEHOLDER form, so a long URL is not 'not Bulgarian'", async () => {
    // A restored URL is a long run of Latin letters, and the Bulgarian check counts
    // letters. Here the URLs outweigh the prose: judging the RESTORED text would condemn
    // a perfectly good translation as "the source appears untranslated".
    stubFetch(echoing);
    const result = await provider().translate(
      requestFor("Заглавие", `See ${URL_A} and ${URL_B} here.`),
      contextFor()
    );

    assert.ok(result.translatedContent?.includes(URL_A));
    // The stored text is the restored one — placeholders are an internal detail.
    assert.ok(!result.translatedContent?.includes("[["));
  });

  it("protects an e-mail address and a model code as well", async () => {
    stubFetch(echoing);
    await provider().translate(
      requestFor("Заглавие", "Write to service@example.com about model DCD-800 today."),
      contextFor()
    );

    const sent = requests.flatMap((r) => bodyTexts(r.body)).join(" ");
    assert.ok(!sent.includes("service@example.com"));
    assert.ok(!sent.includes("DCD-800"));
  });

  it("leaves decimals and units translatable — the model localises them correctly", async () => {
    stubFetch(echoing);
    await provider().translate(
      requestFor("Заглавие", "The needle sits at approx. 12.5 bar for a 90 Nm unit."),
      contextFor()
    );

    const sent = requests.flatMap((r) => bodyTexts(r.body)).join(" ");
    assert.ok(sent.includes("12.5 bar"), "freezing a decimal would force English formatting");
    assert.ok(sent.includes("90 Nm"));
  });
});

// ─── Segment repair: one bad segment must not cost the whole article ──────────

/**
 * MADLAD drops a `[[n]]` placeholder whenever it sits next to a brand token — proved
 * by holding a sentence fixed and varying only the neighbours (see the brand-adjacency
 * regression below). Re-sending it to MADLAD is useless because beam search is
 * deterministic, so the failing segment ALONE goes to the prompt-based engine, and the
 * result is accepted only if every protected value survives byte-for-byte.
 *
 * The fake repair engine here stands in for `OllamaTranslationProvider`. It is a real
 * `TranslationProvider`, so what these tests exercise is the wiring the factory builds,
 * not a parallel code path.
 */
function repairEngine(
  answer: (segment: string) => string | Promise<string>,
  kind: "ollama" | "madlad" = "ollama"
): { provider: TranslationProvider; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    provider: {
      kind,
      providerLabel: "TEXT_WORKER",
      model: "qwen3:8b",
      maxTries: 3,
      async translate(request) {
        calls.push(request.title ?? "");
        return {
          translatedTitle: await answer(request.title ?? ""),
          translatedContent: null,
          tries: 1,
          usedRepair: false,
          repairs: [],
          raw: null,
        };
      },
    },
  };
}

/** A MADLAD provider wired to `engine`, at an explicit batch size. */
function repairing(engine: TranslationProvider | null, batchSize = 30) {
  return new MadladTranslationProvider(
    "http://w:3002",
    "k",
    "google/madlad400-3b-mt",
    "en",
    1,
    batchSize,
    engine === null ? null : async () => engine
  );
}

// ─── Data-only bypass: a spec-table cell is data, not language ────────────────

/**
 * ServeTheHome-style articles arrive with their HTML comparison tables flattened one
 * CELL per line, so an article's specification block becomes dozens of segments that
 * are a single value each ("44GB", "43.2PB/sec", "16U"). `protectTokens` turns each
 * into a bare "[[0]]" — and a lone placeholder is the one input MADLAD reliably
 * mangles, answering "[0]". On feed item 67e084f6-61cf-41c8-8946-608290e7ea83 that was
 * 23 of 33 restoration failures.
 *
 * The bypass is lossless rather than lenient: every value in such a segment is
 * protected, so a SUCCESSFUL restoration would have reproduced the source byte for
 * byte. Returning the source directly is the same answer, reached without the
 * round-trip that can only lose it.
 */
describe("MadladTranslationProvider — data-only segments are never sent", () => {
  it("does not send a bare protected technical value to the model", async () => {
    stubFetch(translated);
    const result = await provider().translate(
      requestFor("Заглавие на статията", "The rack holds the drives.\n\n44GB\n\n43.2PB/sec"),
      contextFor()
    );

    const sent = requests.flatMap((r) => bodyTexts(r.body));
    assert.ok(!sent.includes("[[0]]"), "a lone placeholder must never go on the wire");
    assert.ok(!sent.some((t) => /^\s*(\[\[\d+\]\]\s*)+$/.test(t)));
    const raw = result.raw as Record<string, unknown>;
    assert.equal(raw.bypassedDataOnlySegments, 2);
  });

  it("bypasses a segment of several protected values joined by punctuation", async () => {
    stubFetch(translated);
    const result = await provider().translate(
      requestFor("Заглавие на статията", "The rack holds the drives.\n\nDCD-800 / TX-2/B"),
      contextFor()
    );

    assert.equal((result.raw as Record<string, unknown>).bypassedDataOnlySegments, 1);
  });

  it("does NOT bypass prose that merely CONTAINS a protected value", async () => {
    stubFetch(echoing);
    const result = await provider().translate(
      requestFor("Заглавие на статията", "The system has 44GB of SRAM. Supports 6E networking."),
      contextFor()
    );

    const raw = result.raw as Record<string, unknown>;
    assert.equal(raw.bypassedDataOnlySegments, 0, "one word of prose disqualifies a segment");
    const sent = requests.flatMap((r) => bodyTexts(r.body)).join(" ");
    assert.ok(sent.includes("[[0]]"), "prose segments still go to the model, protected");
  });

  it("stores a bypassed segment byte-identically", async () => {
    stubFetch(translated);
    const result = await provider().translate(
      requestFor("Заглавие на статията", "The rack holds the drives.\n\n43.2PB/sec"),
      contextFor()
    );

    assert.ok(
      result.translatedContent?.includes("43.2PB/sec"),
      "the source value must survive exactly, not as a translation of itself"
    );
  });

  it("keeps bypassed and translated segments in exact source order", async () => {
    stubFetch((body) =>
      reply(bodyTexts(body).map((_, i) => `Преведен сегмент ${i} на български език.`))
    );
    const result = await provider().translate(
      requestFor(
        "Заглавие на статията",
        ["First real sentence here.", "44GB", "Second real sentence here.", "16U"].join("\n\n")
      ),
      contextFor()
    );

    const body = result.translatedContent ?? "";
    const order = ["Преведен сегмент 1", "44GB", "Преведен сегмент 2", "16U"];
    let cursor = -1;
    for (const piece of order) {
      const at = body.indexOf(piece);
      assert.ok(at > cursor, `"${piece}" is out of source order`);
      cursor = at;
    }
    assert.deepEqual((result.raw as Record<string, unknown>).bypassedDataOnlyIndices, [3, 5]);
  });

  it("consumes NO repair quota and is counted apart from repairs and fallbacks", async () => {
    let resolved = 0;
    stubFetch(translated);
    const p = new MadladTranslationProvider(
      "http://w:3002",
      "k",
      "google/madlad400-3b-mt",
      "en",
      1,
      30,
      async () => {
        resolved += 1;
        return null;
      }
    );
    const result = await p.translate(
      requestFor(
        "Заглавие на статията",
        ["A real sentence here.", "44GB", "40GB", "16U", "CS-4"].join("\n\n")
      ),
      contextFor()
    );

    assert.equal(resolved, 0, "a bypass is not a repair — no repair engine is resolved");
    const raw = result.raw as Record<string, unknown>;
    assert.equal(raw.bypassedDataOnlySegments, 4);
    assert.equal(raw.repairedSegments, 0);
    assert.equal(raw.fallbackToOriginalSegments, 0);
  });

  // The shape that started this: a Cerebras-like article whose table cells alone would
  // blow the cap. 40 segments → cap 10. 20 data cells + 4 prose failures: 24
  // interventions without the bypass, 4 with it.
  it("keeps a table-heavy article under the repair cap that its cells alone would blow", async () => {
    const prose = Array.from({ length: 20 }, (_, i) => `Real sentence number ${i + 1} here.`);
    const cells = Array.from({ length: 20 }, (_, i) => `${i + 10}GB`);
    stubFetch((body) =>
      reply(bodyTexts(body).map((_, i) => `Преведен сегмент ${i} на български език.`))
    );

    const result = await provider().translate(
      requestFor("Заглавие на статията", [...prose, ...cells].join("\n\n")),
      contextFor()
    );

    const raw = result.raw as Record<string, unknown>;
    assert.equal(raw.bypassedDataOnlySegments, 20);
    assert.equal(raw.repairedSegments, 0);
    assert.equal(raw.fallbackToOriginalSegments, 0);
    // And every cell is still present, exactly.
    for (const cell of cells) assert.ok(result.translatedContent?.includes(cell));
  });

  it("refuses an article that is nothing BUT data rather than storing it untranslated", async () => {
    stubFetch(translated);
    await assert.rejects(
      provider().translate(requestFor(null, "44GB\n\n40GB\n\n16U"), contextFor()),
      (err: unknown) => err instanceof TranslationParseError && err.reason === "empty_translation"
    );
    assert.equal(requests.length, 0, "nothing translatable means nothing is sent");
  });

  it("still names the correct ARTICLE segment in an error when earlier segments were bypassed", async () => {
    // Segments: 1 title, 2 "44GB" (bypassed), 3 prose. A worker fault on the prose
    // segment must name 3/3, not 2/3, even though it was the 2nd thing SENT.
    stubFetch((body) => reply(bodyTexts(body).map((_, i) => (i === 1 ? "" : "Преведен текст."))));

    await assert.rejects(
      provider().translate(
        requestFor("Заглавие на статията", "44GB\n\nA real sentence here."),
        contextFor()
      ),
      (err: unknown) => err instanceof TranslationTransportError && /segment 3\/3/.test(err.message)
    );
  });
});

describe("MadladTranslationProvider — segment repair", () => {
  // ─── A. The real production case ────────────────────────────────────────────
  // Feed item 8cf9a29f, segment 11/59: an ordinary sentence with a subject and a
  // verb, whose `[[0]]` (E15) MADLAD drops because "MSI's MEG CORELIQUID" sits
  // beside it. Measured live, the prompt engine renders this segment correctly and
  // keeps "E15" byte-identical, so the article completes instead of failing.
  const MSI_SENTENCE =
    "Today, I'm taking a closer look at MSI's MEG CORELIQUID E15 360 all-in-one liquid cooler.";

  it("repairs the real E15 body segment through the prompt engine and completes the article", async () => {
    // MADLAD answers segment 2 without the placeholder — the exact production defect.
    stubFetch((body) =>
      reply(
        bodyTexts(body).map((_, i) =>
          i === 1
            ? "Днес ще разгледам по-отблизо течния охладител който е всичко в едно."
            : "Преведено изречение на български език."
        )
      )
    );
    const engine = repairEngine(
      () => "Днес разглеждам по-близо MSI MEG CORELIQUID E15 360 охладител с течност."
    );

    const result = await repairing(engine.provider).translate(
      requestFor("Заглавие на статията", MSI_SENTENCE),
      contextFor()
    );

    assert.equal(engine.calls.length, 1, "only the failing segment is repaired");
    // The repair engine must receive the ORIGINAL segment with real identifiers —
    // handing it the [[n]] form would recreate the very problem being repaired.
    assert.equal(engine.calls[0], MSI_SENTENCE);
    assert.ok(engine.calls[0].includes("E15"));
    assert.ok(!engine.calls[0].includes("[["));
    // And the identifier survives byte-identically into the stored article.
    assert.ok(result.translatedContent?.includes("E15"));
    const raw = result.raw as Record<string, unknown>;
    assert.equal(raw.repairedSegments, 1);
    assert.equal(raw.fallbackToOriginalSegments, 0);
    assert.deepEqual(raw.repairedSegmentIndices, [2]);
  });

  // ─── B. A repair that transliterates is not a repair ────────────────────────
  // Measured on real segments: the prompt engine renders "Gen.2" as "Ген.2" and
  // "50-Series" as "50-Серия". Both read perfectly and are silently wrong, which is
  // precisely the loss the placeholders exist to prevent.
  it("REJECTS a repair that transliterates the identifier and keeps the original English", async () => {
    stubFetch((body) =>
      reply(
        bodyTexts(body).map((_, i) =>
          i === 1 ? "Акумулаторната бормашина е мощна." : "Преведено изречение на български език."
        )
      )
    );
    const source = "The DeWalt DCD-800 is a powerful cordless drill.";
    const engine = repairEngine(() => "Деуолт ДЦД-800 е мощна безжична бормашина.");

    const result = await repairing(engine.provider).translate(
      requestFor("Заглавие на статията", source),
      contextFor()
    );

    assert.equal(engine.calls.length, 1);
    // The Cyrillic near-miss is discarded entirely — the segment stays English.
    assert.ok(result.translatedContent?.includes(source));
    assert.ok(!result.translatedContent?.includes("ДЦД-800"));
    const raw = result.raw as Record<string, unknown>;
    assert.equal(raw.repairedSegments, 0);
    assert.equal(raw.fallbackToOriginalSegments, 1);
    assert.deepEqual(raw.fallbackSegmentIndices, [2]);
    assert.match(JSON.stringify(raw.repairFailureReasons), /DCD-800/);
  });

  it("requires byte identity for a URL too, not only model codes", async () => {
    // An upper-cased URL reads as "the same" link and is not the same string. The
    // article is padded with healthy Bulgarian segments so that the one English
    // segment left behind cannot drag the whole article under the Bulgarian-share
    // gate — this test is about byte identity, not about that bound.
    stubFetch((body) =>
      reply(
        bodyTexts(body).map((_, i) =>
          i === 1 ? "Указанията са публикувани днес." : `Преведен сегмент ${i} на български език.`
        )
      )
    );
    const engine = repairEngine(() => `Указанията са публикувани на ${URL_A.toUpperCase()} днес.`);
    // Distinct sentences: eight identical ones would trip the repetition gate, since
    // the stub answers each segment with the same Bulgarian string.
    const padding = Array.from(
      { length: 8 },
      (_, i) => `Ordinary sentence number ${i + 1} carrying no data at all.`
    );

    const result = await repairing(engine.provider).translate(
      requestFor(
        "Заглавие на статията",
        [`Guidance is published at ${URL_A} today.`, ...padding].join(" ")
      ),
      contextFor()
    );

    const raw = result.raw as Record<string, unknown>;
    assert.equal(raw.repairedSegments, 0, "a case-changed URL is not the same URL");
    assert.equal(raw.fallbackToOriginalSegments, 1);
  });

  it("does not accept an identifier that is merely a SUBSTRING of a longer token", async () => {
    // "E15" inside "E150" is a different model. Byte identity alone would pass this.
    stubFetch((body) =>
      reply(
        bodyTexts(body).map((_, i) =>
          i === 1 ? "Охладителят е добър." : "Преведено изречение на български език."
        )
      )
    );
    const engine = repairEngine(() => "Охладителят MSI E150 е добър.");

    const result = await repairing(engine.provider).translate(
      requestFor("Заглавие на статията", "The MSI MEG CORELIQUID E15 cooler is good."),
      contextFor()
    );

    const raw = result.raw as Record<string, unknown>;
    assert.equal(raw.repairedSegments, 0);
    assert.equal(raw.fallbackToOriginalSegments, 1);
  });

  // ─── C. The healthy path is untouched ───────────────────────────────────────
  it("never resolves or calls the repair engine when every segment restores cleanly", async () => {
    stubFetch(echoing);
    let resolved = 0;
    const engine = repairEngine(() => "не трябва да се случва");
    const provider = new MadladTranslationProvider(
      "http://w:3002",
      "k",
      "google/madlad400-3b-mt",
      "en",
      1,
      30,
      async () => {
        resolved += 1;
        return engine.provider;
      }
    );

    await provider.translate(
      requestFor("Заглавие", `See ${URL_A} for details about model DCD-800.`),
      contextFor()
    );

    assert.equal(resolved, 0, "a healthy article must never even resolve an LLM");
    assert.equal(engine.calls.length, 0);
  });

  // ─── D. Order is positional, and repair must not disturb it ─────────────────
  it("keeps repaired, fallback and untouched segments in exact source order", async () => {
    // Segment index 0 is the title; body sentences are indices 1-5. Indices 2 and 4
    // fail: 2 repairs cleanly, 4 transliterates and therefore stays English.
    stubFetch((body) =>
      reply(
        bodyTexts(body).map((_, i) => {
          if (i === 2 || i === 4) return "Изречение без запазена стойност.";
          return `Преведен сегмент ${i} на български език.`;
        })
      )
    );
    const engine = repairEngine((segment) =>
      segment.includes("E15") ? "Втори сегмент с E15 запазен." : "Четвърти сегмент с ДЦД-800."
    );

    const result = await repairing(engine.provider).translate(
      requestFor(
        "Заглавие на статията",
        [
          "First ordinary sentence here.",
          "Second sentence about the MSI MEG CORELIQUID E15 cooler.",
          "Third ordinary sentence here.",
          "Fourth sentence about the DeWalt DCD-800 drill.",
          "Fifth ordinary sentence here.",
        ].join(" ")
      ),
      contextFor()
    );

    const body = result.translatedContent ?? "";
    const order = [
      "Преведен сегмент 1",
      "Втори сегмент с E15 запазен.",
      "Преведен сегмент 3",
      "Fourth sentence about the DeWalt DCD-800 drill.",
      "Преведен сегмент 5",
    ];
    let cursor = -1;
    for (const piece of order) {
      const at = body.indexOf(piece);
      assert.ok(at > cursor, `"${piece}" is out of source order`);
      cursor = at;
    }
    const raw = result.raw as Record<string, unknown>;
    assert.deepEqual(raw.repairedSegmentIndices, [3]);
    assert.deepEqual(raw.fallbackSegmentIndices, [5]);
  });

  // ─── E. Too much damage fails the article ───────────────────────────────────
  it("fails the WHOLE article rather than storing one that is mostly English", async () => {
    // 8 segments, every one carrying an identifier MADLAD drops. The cap for 8
    // segments is ceil(8 × 0.25) = 2, so the third failure ends the article.
    stubFetch((body) => reply(bodyTexts(body).map(() => "Изречение без стойност.")));
    const engine = repairEngine(() => "Превод без запазен идентификатор.");
    const content = Array.from(
      { length: 8 },
      (_, i) => `Sentence ${i + 1} about the DeWalt DCD-800 drill.`
    ).join(" ");

    await assert.rejects(
      repairing(engine.provider).translate(requestFor(null, content), contextFor()),
      (err: unknown) =>
        err instanceof TranslationParseError &&
        err.reason === "protected_token" &&
        /needed more than 2 repaired segment/.test(err.message)
    );
  });

  it("scales the cap with article length — measured hardware reviews need 16-21%", async () => {
    assert.equal(maxRepairsFor(59), 12, "MSI: 25% would be 15, the absolute cap is 12");
    assert.equal(maxRepairsFor(29), 8, "XMG needed 6");
    assert.equal(maxRepairsFor(18), 5, "Kioxia needed 3");
    assert.equal(maxRepairsFor(56), 12, "AVerMedia needed 9");
    // The rule this replaced (max 5, or 10%, whichever smaller) would have failed
    // every one of those four real articles.
    assert.ok(maxRepairsFor(29) > Math.min(5, Math.floor(29 * 0.1)));
    assert.equal(maxRepairsFor(4), 1, "a tiny article still gets one repair");
    assert.equal(maxRepairsFor(400), MAX_REPAIRS_PER_ARTICLE, "and a huge one is still bounded");
  });

  // ─── F. The article deadline still wins ─────────────────────────────────────
  it("does not START a repair without a safe budget, and keeps the original instead", async () => {
    stubFetch((body) =>
      reply(
        bodyTexts(body).map((_, i) =>
          i === 1 ? "Изречение без стойност." : "Преведено изречение на български език."
        )
      )
    );
    const engine = repairEngine(() => "не трябва да се случва");
    const source = "The DeWalt DCD-800 is a powerful cordless drill.";

    // Deadline is real but too close to fit a repair inside it.
    const result = await repairing(engine.provider).translate(
      requestFor("Заглавие на статията", source),
      contextFor({ itemDeadlineMs: Date.now() + MIN_REPAIR_BUDGET_MS - 5_000 })
    );

    assert.equal(engine.calls.length, 0, "no repair is attempted without budget");
    assert.ok(result.translatedContent?.includes(source));
    const raw = result.raw as Record<string, unknown>;
    assert.equal(raw.fallbackToOriginalSegments, 1);
    assert.match(JSON.stringify(raw.repairFailureReasons), /item budget/);
  });

  it("reports an EXHAUSTED item deadline as a timeout, not as a fallback", async () => {
    stubFetch((body) =>
      reply(
        bodyTexts(body).map((_, i) =>
          i === 1 ? "Изречение без стойност." : "Преведено изречение на български език."
        )
      )
    );
    const engine = repairEngine(() => "не трябва да се случва");

    await assert.rejects(
      repairing(engine.provider).translate(
        requestFor("Заглавие на статията", "The DeWalt DCD-800 is a powerful cordless drill."),
        contextFor({ itemDeadlineMs: Date.now() - 1 })
      ),
      (err: unknown) => err instanceof TranslationTimeoutError
    );
    assert.equal(engine.calls.length, 0);
  });

  // ─── H / I. The title is segment 1, so it is covered by the same mechanism ───
  it("repairs a TITLE segment and stores the repaired title", async () => {
    stubFetch((body) =>
      reply(
        bodyTexts(body).map((_, i) =>
          i === 0 ? "[0] 360 Преглед на продукта" : "Преведено изречение на български език."
        )
      )
    );
    const engine = repairEngine(() => "MSI MEG CORELIQUID E15 360 Ревю");

    const result = await repairing(engine.provider).translate(
      requestFor("MSI MEG CORELIQUID E15 360 Review", CONTENT),
      contextFor()
    );

    assert.equal(result.translatedTitle, "MSI MEG CORELIQUID E15 360 Ревю");
    assert.ok(result.translatedTitle?.includes("E15"));
    assert.deepEqual((result.raw as Record<string, unknown>).repairedSegmentIndices, [1]);
  });

  it("keeps the ORIGINAL English title — never null — when the title cannot be repaired", async () => {
    stubFetch((body) =>
      reply(
        bodyTexts(body).map((_, i) =>
          i === 0 ? "[0] 360 Преглед на продукта" : "Преведено изречение на български език."
        )
      )
    );
    // Transliterated: rejected, so the source title stands.
    const engine = repairEngine(() => "МСИ МЕГ КОРЕЛИКУИД Е15 360 Ревю");

    const result = await repairing(engine.provider).translate(
      requestFor("MSI MEG CORELIQUID E15 360 Review", CONTENT),
      contextFor()
    );

    // Null here would hand classification and generation an article with NO title,
    // because resolveFeedItemContent returns translatedTitle verbatim beside a body.
    assert.equal(result.translatedTitle, "MSI MEG CORELIQUID E15 360 Review");
    assert.ok(result.translatedContent, "the body is still stored, translated");
    assert.deepEqual((result.raw as Record<string, unknown>).fallbackSegmentIndices, [1]);
  });

  // ─── J / K. Only protected-token failures may be repaired ───────────────────
  it("does NOT repair a repetition loop — that article still fails", async () => {
    // The degenerate segment carries NO protected value, so restoration succeeds and
    // the repetition gate is unambiguously what rejects the article. (A segment that
    // both loops AND drops a placeholder would fail restoration first, which is a
    // protected-token failure and a different test.)
    stubFetch((body) =>
      reply(
        bodyTexts(body).map((_, i) =>
          i === 1 ? `Въпреки това, ${"0".repeat(488)}` : "Преведено изречение на български език."
        )
      )
    );
    const engine = repairEngine(() => "не трябва да се случва");

    await assert.rejects(
      repairing(engine.provider).translate(
        requestFor("Заглавие на статията", "An ordinary sentence with no data in it at all."),
        contextFor()
      ),
      (err: unknown) => err instanceof TranslationParseError && err.reason === "repetition"
    );
    assert.equal(engine.calls.length, 0, "a loop is not a protected-token failure");
  });

  it("does NOT repair an untranslated (wrong-language) reply", async () => {
    stubFetch((body) => reply(bodyTexts(body)));
    const engine = repairEngine(() => "не трябва да се случва");

    await assert.rejects(
      repairing(engine.provider).translate(requestFor(TITLE, CONTENT), contextFor()),
      (err: unknown) => err instanceof TranslationParseError && err.reason === "wrong_language"
    );
    assert.equal(engine.calls.length, 0);
  });

  it("does NOT repair a transport fault — the article fails and may still fall back", async () => {
    stubFetch(() => json({ error: "model not loaded" }, 503));
    const engine = repairEngine(() => "не трябва да се случва");

    await assert.rejects(
      repairing(engine.provider).translate(requestFor(TITLE, CONTENT), contextFor()),
      (err: unknown) => err instanceof TranslationTransportError
    );
    assert.equal(engine.calls.length, 0);
  });

  it("does NOT repair a segment that carried no protected value at all", async () => {
    // An invented placeholder in a segment that had none: there is nothing for the
    // byte-exact check to verify, so a substitution here could never be validated.
    stubFetch((body) =>
      reply(bodyTexts(body).map(() => "Преведен текст с [[0]] в него на български."))
    );
    const engine = repairEngine(() => "не трябва да се случва");

    await assert.rejects(
      repairing(engine.provider).translate(requestFor(TITLE, CONTENT), contextFor()),
      (err: unknown) => err instanceof TranslationParseError && err.reason === "protected_token"
    );
    assert.equal(engine.calls.length, 0);
  });

  it("preserves the pre-repair behaviour exactly when no repair engine is configured", async () => {
    // Graceful degradation is what a deployment gets by CONFIGURING a repair engine,
    // never by omission: with none, an unrestorable segment still fails the article
    // rather than being stored unverified.
    stubFetch((body) =>
      reply(
        bodyTexts(body).map((_, i) =>
          i === 1 ? "Изречение без стойност." : "Преведено изречение на български език."
        )
      )
    );

    await assert.rejects(
      repairing(null).translate(
        requestFor("Заглавие на статията", "The DeWalt DCD-800 is a powerful cordless drill."),
        contextFor()
      ),
      (err: unknown) => err instanceof TranslationParseError && err.reason === "protected_token"
    );
  });

  it("counts repair calls in modelCalls, so a repaired article does not understate its cost", async () => {
    stubFetch((body) =>
      reply(
        bodyTexts(body).map((_, i) =>
          i === 1 ? "Изречение без стойност." : "Преведено изречение на български език."
        )
      )
    );
    const engine = repairEngine(() => "Изречение с DCD-800 запазен.");

    const result = await repairing(engine.provider).translate(
      requestFor("Заглавие на статията", "The DeWalt DCD-800 is a powerful cordless drill."),
      contextFor()
    );

    assert.equal(result.modelCalls, 2, "one MADLAD batch plus one repair call");
  });
});

// ─── Quality gate: the same bar as the prompt-based engine ────────────────────

describe("MadladTranslationProvider — unusable output is rejected, not stored", () => {
  it("rejects an untranslated (still-English) reply", async () => {
    stubFetch((body) => reply(bodyTexts(body)));

    await assert.rejects(
      provider().translate(requestFor(TITLE, CONTENT), contextFor()),
      (err: unknown) => err instanceof TranslationParseError && err.reason === "wrong_language"
    );
  });

  it("rejects a decoding loop", async () => {
    stubFetch((body) =>
      reply(bodyTexts(body).map((_, i) => (i === 0 ? "Заглавие на статията" : "със ".repeat(40))))
    );

    await assert.rejects(
      provider().translate(requestFor(TITLE, CONTENT), contextFor()),
      (err: unknown) => err instanceof TranslationParseError && err.reason === "repetition"
    );
  });

  it("does not dress a rejected translation up as a transport fault", async () => {
    // The distinction that governs the fallback: this must NOT be a transport error.
    stubFetch((body) => reply(bodyTexts(body)));

    await assert.rejects(
      provider().translate(requestFor(TITLE, CONTENT), contextFor()),
      (err: unknown) => !(err instanceof TranslationTransportError)
    );
  });

  // ─── Regression: real production degeneration (MADLAD, feed item 6d3c5514-b786-
  // 48b8-b467-5ad28bfca0ce, 2026-08-20) ──────────────────────────────────────────
  //
  // Segment 17/26 of a real article (source text ending "...pl 5985.") degenerated
  // into a `repeated_char` loop — MADLAD translated the leading clause coherently,
  // then got stuck generating "0" 488 times while producing a number ("1985 г., ...
  // 100000...0"). The other 25 segments in the SAME batch translated fine, and the
  // article-level quality gate correctly rejected the whole thing.
  //
  // INVESTIGATED AND REJECTED: an isolated-segment retry (re-sending only the failing
  // segment, singular or as a batch of one, and accepting it if that attempt passes).
  // Live against the real worker, the exact failing segment was sent 3x via singular
  // `{text}` and 3x via `texts:[one]` — all 6 runs reproduced the IDENTICAL 543-char
  // degenerate output, byte for byte. This is not a coincidence: `protectTokens`
  // output for one segment never depends on what else is in its batch, and MADLAD's
  // beam search is deterministic (`maxTries = 1` above, for the same reason) — so a
  // segment that degenerates has EXACTLY the same input whether it is retried alone
  // or was part of a batch, and therefore is GUARANTEED to reproduce the same
  // output. An isolated retry can only ever help a failure that batching itself
  // caused (cross-segment contamination, padding, etc.) — proven NOT the case here —
  // never a failure that is a property of the segment's own content. Implementing a
  // retry here would add HTTP calls and complexity for a class of failure it can
  // never fix, so `translate()` correctly still fails the WHOLE article on any
  // single degenerate segment, exactly as it did before batching existed.
  it("fails the WHOLE article when exactly one segment in an otherwise-healthy batch degenerates", async () => {
    stubFetch((body) =>
      reply(
        bodyTexts(body).map((t, i) =>
          i === 16 ? `Въпреки това, ${"0".repeat(488)}` : `Преведен сегмент ${i} на български език.`
        )
      )
    );

    const p = new MadladTranslationProvider(
      "http://w:3002",
      "k",
      "google/madlad400-3b-mt",
      "en",
      1,
      30
    );
    const content = Array.from(
      { length: 25 },
      (_, i) => `Real sentence number ${i + 1} here.`
    ).join(" ");

    await assert.rejects(
      p.translate(requestFor(TITLE, content), contextFor()),
      (err: unknown) => err instanceof TranslationParseError && err.reason === "repetition"
    );
    assert.equal(
      requests.length,
      1,
      "no retry is attempted — the whole article fails on the first batch"
    );
  });

  // ─── Regression: real production title failure (MADLAD, feed item
  // 8cf9a29f-4778-4f5b-a4e7-8dcb7977bc5f, 2026-08-20, "MSI MEG CORELIQUID E15 360
  // Review") ──────────────────────────────────────────────────────────────────────
  //
  // The title is always segment 1 (`segmentArticle` sends it whole, never through the
  // sentence splitter). `E15` is a genuine model identifier and `protectTokens` froze
  // it correctly: "MSI MEG CORELIQUID [[0]] 360 Review" went on the wire. The worker
  // returned "[0] 360 Преглед на продукта" — MSI/MEG/CORELIQUID dropped outright, and
  // the placeholder itself collapsed from double brackets to single ("[[0]]" → "[0]"),
  // which `restoreTokens`'s `\[\[(\d+)\]\]` pattern correctly does not match, so it is
  // reported (accurately) as dropped. Reproduced here byte-for-byte against the real
  // production error message.
  //
  // INVESTIGATED AND REJECTED: changing the placeholder syntax (`#0#`, `@0@`) or
  // switching to "translate unprotected, verify byte-identity, fall back to
  // protection". Both were measured live against the real worker on this exact title
  // and on several other genuine identifiers (DCD-800, TX-2/B, P2, 230V, v2.14.3) in
  // both title and full-sentence position, repeated 3x each (MADLAD's beam search is
  // deterministic, so repeats confirm rather than sample):
  //
  //   • CORRECTED 2026-08-20, see `brand-adjacent` below: an earlier revision of this
  //     comment claimed identifiers "survive reliably in a normal SENTENCE". That was
  //     WRONG, and wrong in a way worth recording, because it was drawn from short,
  //     simple probe sentences whose identifier had no brand neighbour. Re-measured
  //     with the identifier's NEIGHBOURS as the variable, a placeholder is lost in
  //     ordinary prose too. What survives is an identifier standing on its own as a
  //     grammatical subject ("The DJI [[0]] is a compact drone." → kept); what is lost
  //     is the same placeholder next to a brand token ("The DeWalt [[0]] is a powerful
  //     cordless drill." → dropped). Sentence-vs-title was never the real variable.
  //   • In TITLE position specifically — a bare noun phrase with no verb, several
  //     consecutive brand/model tokens and no sentence grammar for the placeholder to
  //     anchor to — content loss happened with EVERY strategy tried, protected or
  //     unprotected, `[[0]]`/`#0#`/`@0@` alike: MSI/MEG/CORELIQUID/DDR5-6000/PW313D/G2
  //     were dropped outright, or the whole title was replaced with unrelated
  //     hallucinated Bulgarian prose, in both directions. The unprotected form is not
  //     a safe fallback either — MADLAD homoglyph-substituted the identifier itself in
  //     one run ("E15" → "Е15", Cyrillic constituent letter, byte-different) while
  //     transliterating the surrounding brand tokens.
  //   • Critically, `#0#` "survived" as a raw token in one run while everything AROUND
  //     it was hallucinated into an unrelated sentence — a worse outcome than today's
  //     rejection, because a token merely surviving inside fabricated prose would pass
  //     `restoreTokens` and could pass the language/repetition gates too, storing a
  //     fabricated title as if it were a translation. Today's placeholder-mangling
  //     failure is accidental, but it is not silent: it rejects rather than stores.
  //
  // No placeholder syntax or byte-identity check closes that gap, so none is applied
  // here — see `brand-adjacent` below for what the real variable turned out to be.
  it("REJECTS the exact production title failure — a headline's placeholder collapses, not just drops", async () => {
    stubFetch((body) =>
      reply(
        bodyTexts(body).map((_, i) =>
          i === 0 ? "[0] 360 Преглед на продукта" : "Преведен сегмент на български език."
        )
      )
    );

    await assert.rejects(
      provider().translate(requestFor("MSI MEG CORELIQUID E15 360 Review", CONTENT), contextFor()),
      (err: unknown) =>
        err instanceof TranslationParseError &&
        err.reason === "protected_token" &&
        /dropped \[\[0\]\] in segment 1\/\d+/.test(err.message) &&
        /\(E15\)/.test(err.message)
    );
  });

  // ─── Regression: the SAME feed item fails in its BODY too — the real variable is a
  // BRAND-ADJACENT placeholder, not a headline ────────────────────────────────────
  //
  // Routing the title away from MADLAD does NOT make 8cf9a29f translatable. Run
  // DB-free against the real worker with the title withheld, the article still failed —
  // at segment 10/58, which is an ordinary, well-formed sentence with a subject and a
  // verb:
  //
  //   "Today, I'm taking a closer look at MSI's MEG CORELIQUID [[0]] 360
  //    all-in-one liquid cooler."
  //     → "Днес ще разгледам по-отблизо течния охладител който е всичко в едно."
  //
  // Every brand token AND the placeholder are gone. Holding the sentence fixed and
  // varying ONLY the number of brand tokens beside the placeholder isolates the cause
  // exactly (real worker, 2026-08-20):
  //
  //   "…a closer look at the [[0]] all-in-one liquid cooler."             KEPT
  //   "…a closer look at the MSI [[0]] all-in-one liquid cooler."         LOST
  //   "…a closer look at the MSI MEG [[0]] all-in-one liquid cooler."     LOST
  //   "…a closer look at the MSI MEG CORELIQUID [[0]] all-in-one …"       LOST
  //
  // ONE adjacent brand token is enough. The same effect explains the controls that
  // looked like passes earlier: "The DJI [[0]] is a compact drone." keeps its
  // placeholder (the identifier is the subject) while "The DeWalt [[0]] is a powerful
  // cordless drill." loses it — same shape, same length, same position, different
  // neighbour. So this is one failure class, not a title one and a body one, and a
  // title-level fix cannot close it: `translate()` deliberately still fails the WHOLE
  // article, which is why 8cf9a29f is not retryable until a segment-level repair
  // exists. See the final report for the proposed (not implemented) design.
  it("REJECTS a brand-adjacent placeholder in ORDINARY BODY PROSE, not just in a headline", async () => {
    // Segment 1 is the title and translates fine here; the failure is in the body,
    // which is the whole point — this article has no headline problem left to blame.
    stubFetch((body) =>
      reply(
        bodyTexts(body).map((_, i) =>
          i === 1
            ? "Днес ще разгледам по-отблизо течния охладител който е всичко в едно."
            : "Преведен сегмент на български език."
        )
      )
    );

    await assert.rejects(
      provider().translate(
        requestFor(
          "Заглавие на статията",
          "Today, I'm taking a closer look at MSI's MEG CORELIQUID E15 360 all-in-one liquid cooler."
        ),
        contextFor()
      ),
      (err: unknown) =>
        err instanceof TranslationParseError &&
        err.reason === "protected_token" &&
        /dropped \[\[0\]\] in segment 2\/\d+/.test(err.message) &&
        /\(E15\)/.test(err.message)
    );
  });
});

// ─── Transport faults: distinct from bad output, because only these may fall back ──

describe("MadladTranslationProvider — transport faults", () => {
  const rejectsAsTransport = (match: RegExp) => (err: unknown) =>
    err instanceof TranslationTransportError && match.test(err.message);

  it("reports a non-2xx as a transport fault", async () => {
    stubFetch(() => json({ error: "model not loaded" }, 503));

    await assert.rejects(
      provider().translate(requestFor(TITLE, CONTENT), contextFor()),
      rejectsAsTransport(/503/)
    );
  });

  it("reports a worker-level refusal as a transport fault, not as a translation", async () => {
    stubFetch(() => json({ error: "no language token for 'zz'", provider: "madlad" }));

    await assert.rejects(
      provider().translate(requestFor(TITLE, CONTENT), contextFor()),
      rejectsAsTransport(/refused/)
    );
  });

  it("reports a malformed JSON body", async () => {
    stubFetch(() => new Response("not json at all", { status: 200 }));

    await assert.rejects(
      provider().translate(requestFor(TITLE, CONTENT), contextFor()),
      rejectsAsTransport(/non-JSON/)
    );
  });

  it("reports a missing texts array rather than storing undefined", async () => {
    stubFetch(() => json({ provider: "madlad", model: "google/madlad400-3b-mt" }));

    await assert.rejects(
      provider().translate(requestFor(TITLE, CONTENT), contextFor()),
      rejectsAsTransport(/no texts array/)
    );
  });

  it("reports a non-array texts field", async () => {
    stubFetch(() => json({ texts: "not an array", provider: "madlad" }));

    await assert.rejects(
      provider().translate(requestFor(TITLE, CONTENT), contextFor()),
      rejectsAsTransport(/no texts array/)
    );
  });

  it("rejects a response whose entry count does not match the request", async () => {
    // Requested 3 segments (title + 2 paragraphs), worker answers with only 2.
    stubFetch(() => reply(["Едно.", "Две."]));

    await assert.rejects(
      provider().translate(requestFor(TITLE, CONTENT), contextFor()),
      rejectsAsTransport(/2 translation\(s\) for 3 segment\(s\) requested/)
    );
  });

  it("reports a non-string entry within an otherwise well-formed batch", async () => {
    stubFetch(() => json({ texts: [42, "Две.", "Три."], provider: "madlad" }));

    await assert.rejects(
      provider().translate(requestFor(TITLE, CONTENT), contextFor()),
      rejectsAsTransport(/no text for segment 1\/3/)
    );
  });

  it("refuses an empty translation rather than silently losing the paragraph", async () => {
    stubFetch((body) =>
      reply(bodyTexts(body).map((_, i) => (i === 0 ? "   " : "Преведен текст.")))
    );

    await assert.rejects(
      provider().translate(requestFor(TITLE, CONTENT), contextFor()),
      rejectsAsTransport(/empty translation/)
    );
  });

  it("refuses a foreign envelope — a /generate reply must never pass as MADLAD", async () => {
    // Shaped exactly like a valid reply except for the provider. Accepting it would
    // store a chat model's output under MADLAD's name and invalidate the comparison.
    stubFetch(() => json({ texts: ["Някакъв текст на български език тук."], provider: "ollama" }));

    await assert.rejects(
      provider().translate(requestFor(TITLE, null), contextFor()),
      rejectsAsTransport(/foreign envelope/)
    );
  });

  it("refuses a reply with no provider envelope at all", async () => {
    stubFetch(() => json({ texts: ["Някакъв текст на български език тук."] }));

    await assert.rejects(
      provider().translate(requestFor(TITLE, null), contextFor()),
      rejectsAsTransport(/foreign envelope/)
    );
  });

  it("reports an unreachable worker", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    await assert.rejects(
      provider().translate(requestFor(TITLE, CONTENT), contextFor()),
      rejectsAsTransport(/unreachable/)
    );
  });

  it("reports an aborted request as a deadline, not as an unreachable worker", async () => {
    globalThis.fetch = (async () => {
      const err = new Error("The operation was aborted");
      err.name = "TimeoutError";
      throw err;
    }) as typeof fetch;

    await assert.rejects(
      provider().translate(requestFor(TITLE, CONTENT), contextFor()),
      rejectsAsTransport(/deadline/)
    );
  });

  it("names the exact ARTICLE-level segment that failed, even inside a shared batch", async () => {
    // All 3 segments ride in ONE batch (default batch size 30); only the 3rd entry in
    // the reply is bad. The error must still say "segment 3/3", not "entry 3 of batch".
    stubFetch((body) => reply(bodyTexts(body).map((_, i) => (i === 2 ? "" : "Преведен текст."))));

    await assert.rejects(
      provider().translate(requestFor(TITLE, CONTENT), contextFor()),
      rejectsAsTransport(/segment 3\/3/)
    );
  });

  it("names the segment correctly relative to its OWN batch, not just the article", async () => {
    // batch size 2: batches are [title, para1] and [para2]. para2 is article-index 3,
    // but batch-local index 1 — the error must report the ARTICLE index (3/3), proving
    // startIndex is threaded through correctly rather than reset per batch.
    stubFetch((body) => reply(bodyTexts(body).map(() => "")));
    const p = new MadladTranslationProvider(
      "http://w:3002",
      "k",
      "google/madlad400-3b-mt",
      "en",
      1,
      2
    );

    await assert.rejects(
      p.translate(requestFor(TITLE, CONTENT), contextFor()),
      (err: unknown) =>
        err instanceof TranslationTransportError && /segment 1\/3 \(batch 1\/2\)/.test(err.message)
    );
  });
});

// ─── Budgets ──────────────────────────────────────────────────────────────────

describe("MadladTranslationProvider — budgets", () => {
  it("times out a batch that outlives the remaining ITEM budget", async () => {
    // A batch's budget is its fair share of the time left on the ITEM deadline — NOT
    // `attemptTimeoutMs`, which is deliberately not consulted for batches any more (see
    // the 90s production abort documented in `translate()`). So the item deadline is
    // what has to be short here for a hung worker to be cut loose.
    globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch;

    await assert.rejects(
      provider().translate(
        requestFor(TITLE, null),
        contextFor({ itemDeadlineMs: Date.now() + 20, itemTimeoutMs: 20 })
      ),
      (err: unknown) => err instanceof TranslationTimeoutError
    );
  });

  it("stops before starting a new BATCH once the item deadline passes", async () => {
    // Every call is fine; the clock is what runs out. Batch size 1 forces one HTTP call
    // per segment, so this exercises exactly the same timing shape the old per-segment
    // loop did — now expressed as "between batches" rather than "between segments".
    let clock = Date.now();
    stubFetch((body) => {
      clock += 1_000;
      return translated(body);
    });

    const p = new MadladTranslationProvider(
      "http://w:3002",
      "k",
      "google/madlad400-3b-mt",
      "en",
      1,
      1
    );
    await assert.rejects(
      p.translate(
        requestFor(TITLE, CONTENT),
        contextFor({ now: () => new Date(clock), itemDeadlineMs: clock + 1_500 })
      ),
      (err: unknown) => err instanceof TranslationTimeoutError
    );
    assert.ok(requests.length < 3, "it must not have run every batch");
  });

  it("stops before starting a new batch even when several segments share each batch", async () => {
    // 6 segments, batch size 2 -> 3 planned batches. The clock exhausts the budget
    // after the first batch, so the second and third must never be sent.
    let clock = Date.now();
    stubFetch((body) => {
      clock += 1_000;
      return translated(body);
    });

    const p = new MadladTranslationProvider(
      "http://w:3002",
      "k",
      "google/madlad400-3b-mt",
      "en",
      1,
      2
    );
    await assert.rejects(
      p.translate(
        requestFor(null, "One. Two. Three. Four. Five. Six."),
        contextFor({ now: () => new Date(clock), itemDeadlineMs: clock + 1_500 })
      ),
      (err: unknown) => err instanceof TranslationTimeoutError
    );
    assert.ok(requests.length < 3, "it must not have run every planned batch");
  });

  // ─── Regression: the real 90s batch abort ──────────────────────────────────
  //
  // Feed item 0a0e3631-2fed-4283-b686-3506a31fbc09 (2026-08-20): 29 segments, ONE
  // batch, aborted at 90090ms with "MADLAD request exceeded its deadline (batch
  // 1/1)" — while the 210s item budget still had ~120s left. The cause was
  // `min(context.attemptTimeoutMs, remainingMs)`: TRANSLATION_ATTEMPT_TIMEOUT_MS is
  // 90s, a shared cron-linked constant sized for ONE model call (one Ollama
  // completion, or one tiny pre-batching MADLAD segment), which silently became the
  // ceiling for a whole 29-segment batch. Real benchmarks show large batches
  // legitimately exceed 90s.
  // These use REAL timers with small values (the provider's timeout race is a real
  // setTimeout), scaled so the ratio that matters is the production one: a batch that
  // runs LONGER than `attemptTimeoutMs` but SHORTER than the item budget. Under the
  // old `min(attemptTimeoutMs, remainingMs)` every one of these aborted; under the
  // fair-share budget they complete.
  describe("a batch may outlive the per-attempt constant when the item deadline allows", () => {
    /** Answers after `ms` of REAL time — the clock the timeout race actually watches. */
    function slowWorker(ms: number) {
      stubFetch(
        (body) =>
          new Promise<Response>((resolve) => setTimeout(() => resolve(translated(body)), ms))
      );
    }

    it("completes a batch that runs well past attemptTimeoutMs — the exact production abort", async () => {
      // attemptTimeoutMs 20ms, worker takes 150ms, item budget 5s. This is the 90s/210s
      // production shape in miniature: under the old code the batch was cut at
      // `attemptTimeoutMs` even though the item deadline had plenty left.
      slowWorker(150);

      const p = new MadladTranslationProvider("http://w:3002", "k", "google/madlad400-3b-mt");
      const result = await p.translate(
        requestFor(TITLE, CONTENT),
        contextFor({
          attemptTimeoutMs: 20,
          itemDeadlineMs: Date.now() + 5_000,
          itemTimeoutMs: 5_000,
        })
      );

      assert.equal(requests.length, 1, "one batch");
      assert.ok(
        result.translatedContent,
        "a batch longer than attemptTimeoutMs must NOT be aborted while item time remains"
      );
    });

    it("still aborts a batch that outlives the remaining ITEM budget", async () => {
      // The deadline is still real and still enforced — it is now the ITEM budget
      // rather than the shared attempt constant.
      globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch;

      const p = new MadladTranslationProvider("http://w:3002", "k", "google/madlad400-3b-mt");
      await assert.rejects(
        p.translate(
          requestFor(TITLE, CONTENT),
          contextFor({
            attemptTimeoutMs: 90_000,
            itemDeadlineMs: Date.now() + 60,
            itemTimeoutMs: 60,
          })
        ),
        (err: unknown) => err instanceof TranslationTimeoutError
      );
    });

    it("gives each batch only a SHARE of the remaining time, so batch 1 cannot starve the rest", async () => {
      // 10 segments at batch size 2 -> 5 batches, item budget 1000ms. Fair share is
      // ~200ms for the first batch, so a hung worker is cut loose at roughly that,
      // NOT after consuming the article's whole 1000ms allowance.
      globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch;

      const p = new MadladTranslationProvider(
        "http://w:3002",
        "k",
        "google/madlad400-3b-mt",
        "en",
        1,
        2
      );
      const startedAt = Date.now();
      await assert.rejects(
        p.translate(
          requestFor(null, "One. Two. Three. Four. Five. Six. Seven. Eight. Nine. Ten."),
          contextFor({
            attemptTimeoutMs: 90_000,
            itemDeadlineMs: startedAt + 1_000,
            itemTimeoutMs: 1_000,
          })
        ),
        (err: unknown) => err instanceof TranslationTimeoutError
      );

      const elapsed = Date.now() - startedAt;
      assert.ok(
        elapsed < 700,
        `batch 1 must not consume the whole item budget; it took ${elapsed}ms of 1000ms`
      );
    });

    it("lets every batch of a multi-batch article finish inside one item deadline", async () => {
      // The other half of fairness: five quick batches must all complete, and the whole
      // article must still land inside its item budget.
      slowWorker(20);

      const p = new MadladTranslationProvider(
        "http://w:3002",
        "k",
        "google/madlad400-3b-mt",
        "en",
        1,
        2
      );
      const startedAt = Date.now();
      const result = await p.translate(
        requestFor(null, "One. Two. Three. Four. Five. Six. Seven. Eight. Nine. Ten."),
        contextFor({
          attemptTimeoutMs: 20,
          itemDeadlineMs: startedAt + 5_000,
          itemTimeoutMs: 5_000,
        })
      );

      assert.equal(requests.length, 5, "five batches");
      assert.ok(result.translatedContent);
      assert.ok(Date.now() - startedAt < 5_000, "the article must finish inside its item deadline");
    });
  });

  it("refuses an article that sanitises down to nothing", async () => {
    stubFetch(translated);
    await assert.rejects(
      provider().translate(requestFor(null, "   "), contextFor()),
      (err: unknown) => err instanceof TranslationTransportError
    );
    assert.equal(requests.length, 0, "no call may be made for an empty article");
  });
});

// ─── HTTP batching (TRANSLATION_MADLAD_HTTP_BATCH_SIZE) ───────────────────────
//
// Integrates the text-worker's batch API (commit d829fec): protected segments are
// chunked into sequential `texts[]` HTTP calls instead of one call per segment.
// Measured against the real production worker (2026-08-20, feed item 825c8475, 120
// real segments): sequential single-segment calls took 189.4s over 120 HTTP requests;
// batches of 30 (4 HTTP requests) took 124.9s — a 1.52x speedup, with ordering,
// protected-token restoration, and memory verified stable. Batches are always sent
// SEQUENTIALLY, never concurrently — see the class header and
// `DEFAULT_MADLAD_CONCURRENCY`'s comment for why client-side concurrency is a
// different, proven-harmful lever, superseded by batching for MADLAD specifically.
describe("MadladTranslationProvider — HTTP batching", () => {
  function makeSegments(n: number): string {
    return Array.from({ length: n }, (_, i) => `Segment number ${i + 1} of the article.`).join(" ");
  }

  it("splits a 120-segment article into exactly 4 HTTP requests at batch size 30", async () => {
    stubFetch(translated);
    const p = new MadladTranslationProvider(
      "http://w:3002",
      "k",
      "google/madlad400-3b-mt",
      "en",
      1,
      30
    );
    // 119 body segments + 1 title = 120 total; batches of 30 -> 4 requests.
    await p.translate(requestFor(TITLE, makeSegments(119)), contextFor());

    assert.equal(requests.length, 4);
    assert.deepEqual(
      requests.map((r) => bodyTexts(r.body).length),
      [30, 30, 30, 30]
    );
  });

  it("preserves source order in the reassembled article across multiple batches", async () => {
    // Each segment's translation encodes its OWN source number in Cyrillic digits'
    // position, so a pass here can only mean each translated entry landed back at its
    // own source position, batch after batch — never at the position it happened to
    // be answered from.
    stubFetch((body) =>
      reply(
        bodyTexts(body).map((t) => {
          const n = /number (\d+)/.exec(t)?.[1] ?? "?";
          return `Преведен сегмент номер ${n} от статията на български език.`;
        })
      )
    );
    const p = new MadladTranslationProvider(
      "http://w:3002",
      "k",
      "google/madlad400-3b-mt",
      "en",
      1,
      4
    );

    const result = await p.translate(requestFor(null, makeSegments(10)), contextFor());

    const expected = Array.from(
      { length: 10 },
      (_, i) => `Преведен сегмент номер ${i + 1} от статията на български език.`
    ).join(" ");
    assert.equal(result.translatedContent, expected);
  });

  it("rejects the WHOLE article when one batch fails, even after earlier batches succeeded", async () => {
    let call = 0;
    stubFetch((body) => {
      call += 1;
      if (call === 2) return json({ error: "boom", provider: "madlad" }, 500);
      return translated(body);
    });

    const p = new MadladTranslationProvider(
      "http://w:3002",
      "k",
      "google/madlad400-3b-mt",
      "en",
      1,
      4
    );
    await assert.rejects(
      p.translate(requestFor(null, makeSegments(10)), contextFor()),
      (err: unknown) => err instanceof TranslationTransportError && /500/.test(err.message)
    );
    assert.equal(call, 2, "the third batch must never be sent once the second one failed");
  });

  it("rejects the whole article on a protected-token failure inside one of several batches", async () => {
    const URL_X = "https://example.com/x";
    stubFetch((body) => {
      const texts = bodyTexts(body);
      // Drop the placeholder only for the segment carrying the URL — everything else
      // echoes back cleanly, so a pass here proves ONE bad segment still fails the lot.
      return reply(
        texts.map((t) => (t.includes("[[0]]") ? "Изречение без адрес." : "Преведено изречение."))
      );
    });

    const p = new MadladTranslationProvider(
      "http://w:3002",
      "k",
      "google/madlad400-3b-mt",
      "en",
      1,
      4
    );
    await assert.rejects(
      p.translate(requestFor(null, `Visit ${URL_X} for details. ${makeSegments(8)}`), contextFor()),
      (err: unknown) => err instanceof TranslationParseError && err.reason === "protected_token"
    );
  });

  it("batch size 1 sends one texts[] call per segment and still works end to end", async () => {
    stubFetch(translated);
    const p = new MadladTranslationProvider(
      "http://w:3002",
      "k",
      "google/madlad400-3b-mt",
      "en",
      1,
      1
    );
    const result = await p.translate(requestFor(TITLE, CONTENT), contextFor());

    assert.equal(requests.length, 3, "title + two paragraphs, one HTTP call each");
    for (const request of requests) {
      assert.equal(
        bodyTexts(request.body).length,
        1,
        "batch size 1 still uses the texts[] contract"
      );
    }
    assert.ok(result.translatedContent);
  });

  it("setting concurrency has NO effect on batch dispatch — batches always run sequentially", async () => {
    // The client-side concurrency mechanism is superseded by batching for MADLAD: it is
    // kept parsing for backward compatibility (see DEFAULT_MADLAD_CONCURRENCY), but must
    // never cause simultaneous /translate requests here, regardless of its value.
    let inFlight = 0;
    let maxInFlight = 0;
    stubFetch(async (body) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      return translated(body);
    });

    // concurrency=5 (would have meant 5-at-once under the old mechanism), batch size 2.
    const p = new MadladTranslationProvider(
      "http://w:3002",
      "k",
      "google/madlad400-3b-mt",
      "en",
      5,
      2
    );
    await p.translate(requestFor(null, makeSegments(10)), contextFor());

    assert.equal(maxInFlight, 1, "batches must never overlap, whatever `concurrency` is set to");
  });
});
