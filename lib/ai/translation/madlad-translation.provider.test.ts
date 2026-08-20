import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MadladTranslationProvider } from "./madlad-translation.provider";
import { TranslationTransportError } from "./translation-provider";
import type { ArticleTranslationContext } from "./translation-provider";
import { TranslationTimeoutError } from "./translation-timeout";
import { buildTranslationPrompts, TranslationParseError } from "@/lib/ai/feed-item-translation";
import { GenerationTracer } from "@/lib/generation-trace/tracer";
import type { PersistableRun } from "@/lib/generation-trace/store";

/**
 * The wire contract asserted here is the one the RUNNING Mac worker implements:
 * one text per call, `{ text, sourceLanguage, targetLanguage }` in and
 * `{ text, provider, model, durationMs }` out. Nothing here talks to a real worker.
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

/** A well-formed worker reply carrying `text`. */
function reply(text: string, extra: Record<string, unknown> = {}): Response {
  return json({
    text,
    provider: "madlad",
    model: "google/madlad400-3b-mt",
    durationMs: 412,
    ...extra,
  });
}

/** Answers every segment with plausible Bulgarian, so the quality gate is satisfied. */
let counter = 0;
function translated(): Response {
  counter += 1;
  return reply(`Преведен сегмент ${counter} на български език.`);
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

  it("sends exactly text + sourceLanguage + targetLanguage, and nothing else", async () => {
    stubFetch(translated);
    await provider().translate(requestFor(TITLE, null), contextFor());

    assert.deepEqual(requests[0].body, {
      text: TITLE,
      sourceLanguage: "en",
      targetLanguage: "bg",
    });
  });

  it("sends ONE text per call — one call per segment, in document order", async () => {
    stubFetch(translated);
    await provider().translate(requestFor(TITLE, CONTENT), contextFor());

    assert.equal(requests.length, 3, "title + two paragraphs");
    assert.deepEqual(
      requests.map((r) => r.body.text),
      [TITLE, "A fire extinguisher can last between 5 and 15 years.", "Check the pressure gauge."]
    );
  });

  it("sends only the title for a bodyless article", async () => {
    stubFetch(translated);
    await provider().translate(requestFor(TITLE, null), contextFor());

    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.text, TITLE);
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

  it("reports the HTTP calls separately, because one attempt is many calls here", async () => {
    stubFetch(translated);
    const result = await provider().translate(requestFor(TITLE, CONTENT), contextFor());

    assert.equal(result.modelCalls, 3);
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

  it("sums the worker's own durations and carries the device through for the trace", async () => {
    stubFetch(() => reply("Преведен текст на български език.", { device: "mps", durationMs: 100 }));
    const result = await provider().translate(requestFor(TITLE, CONTENT), contextFor());

    assert.deepEqual(result.raw, {
      provider: "madlad",
      model: "google/madlad400-3b-mt",
      device: "mps",
      durationMs: 300,
      segmentCount: 3,
      workerCalls: 3,
      protectedTokens: 0,
    });
  });

  it("records the segment and call counts on the trace", async () => {
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
    assert.equal(meta("llm_call").workerCalls, 3);
    // The engine's own name, on the step that shows what was sent.
    assert.equal(meta("prompt").engine, "madlad");
    assert.equal(meta("prompt").model, "google/madlad400-3b-mt");
  });
});

// ─── Protected values: URLs must survive the round trip ──────────────────────

describe("MadladTranslationProvider — protected values", () => {
  const URL_A = "https://example.com/safety/extinguisher-checklist";
  const URL_B = "https://example.com/b";

  /** Answers in Bulgarian, echoing back whatever placeholders it was given. */
  function echoing(body: Record<string, unknown>): Response {
    const text = String(body.text);
    const holders = text.match(/\[\[\d+\]\]/g) ?? [];
    return reply(
      holders.length > 0
        ? `Преведено изречение с ${holders.join(" и ")} на български език.`
        : "Преведено изречение на български език."
    );
  }

  it("never sends a raw URL to the model — it would be translated or deleted", async () => {
    stubFetch(echoing);
    await provider().translate(
      requestFor("Заглавие", `Full inspection guidance is published at ${URL_A} today.`),
      contextFor()
    );

    for (const request of requests) {
      assert.ok(
        !String(request.body.text).includes("example.com"),
        `a raw URL reached the model: ${request.body.text}`
      );
    }
    assert.ok(requests.some((r) => String(r.body.text).includes("[[0]]")));
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

  it("REJECTS a translation that dropped a placeholder — no silent URL loss", async () => {
    // Exactly what the first real benchmark produced, before the placeholders existed:
    // a fluent Bulgarian sentence with the URL simply gone.
    stubFetch(() => reply("Пълните указания за проверка са публикувани на адрес."));

    await assert.rejects(
      provider().translate(
        requestFor("Заглавие", `Full inspection guidance is published at ${URL_A} today.`),
        contextFor()
      ),
      (err: unknown) => err instanceof TranslationParseError && err.reason === "protected_token"
    );
  });

  it("REJECTS a translation that duplicated a placeholder", async () => {
    stubFetch(() => reply("Указанията са на [[0]] и на [[0]] едновременно."));

    await assert.rejects(
      provider().translate(
        requestFor("Заглавие", `Guidance is published at ${URL_A} today.`),
        contextFor()
      ),
      (err: unknown) => err instanceof TranslationParseError && err.reason === "protected_token"
    );
  });

  it("REJECTS a translation that mangled a placeholder", async () => {
    stubFetch(() => reply("Указанията са публикувани на __ днес и още нещо."));

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
    stubFetch(() => reply("Вижте https://spam.example.net/x за повече информация."));

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

    const sent = requests.map((r) => String(r.body.text)).join(" ");
    assert.ok(!sent.includes("service@example.com"));
    assert.ok(!sent.includes("DCD-800"));
  });

  it("leaves decimals and units translatable — the model localises them correctly", async () => {
    stubFetch(echoing);
    await provider().translate(
      requestFor("Заглавие", "The needle sits at approx. 12.5 bar for a 90 Nm unit."),
      contextFor()
    );

    const sent = requests.map((r) => String(r.body.text)).join(" ");
    assert.ok(sent.includes("12.5 bar"), "freezing a decimal would force English formatting");
    assert.ok(sent.includes("90 Nm"));
  });
});

// ─── Quality gate: the same bar as the prompt-based engine ────────────────────

describe("MadladTranslationProvider — unusable output is rejected, not stored", () => {
  it("rejects an untranslated (still-English) reply", async () => {
    stubFetch((body) => reply(String(body.text)));

    await assert.rejects(
      provider().translate(requestFor(TITLE, CONTENT), contextFor()),
      (err: unknown) => err instanceof TranslationParseError && err.reason === "wrong_language"
    );
  });

  it("rejects a decoding loop", async () => {
    let n = 0;
    stubFetch(() => {
      n += 1;
      return reply(n === 1 ? "Заглавие на статията" : "със ".repeat(40));
    });

    await assert.rejects(
      provider().translate(requestFor(TITLE, CONTENT), contextFor()),
      (err: unknown) => err instanceof TranslationParseError && err.reason === "repetition"
    );
  });

  it("does not dress a rejected translation up as a transport fault", async () => {
    // The distinction that governs the fallback: this must NOT be a transport error.
    stubFetch((body) => reply(String(body.text)));

    await assert.rejects(
      provider().translate(requestFor(TITLE, CONTENT), contextFor()),
      (err: unknown) => !(err instanceof TranslationTransportError)
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

  it("reports a missing text field rather than storing undefined", async () => {
    stubFetch(() => json({ provider: "madlad", model: "google/madlad400-3b-mt" }));

    await assert.rejects(
      provider().translate(requestFor(TITLE, CONTENT), contextFor()),
      rejectsAsTransport(/no text/)
    );
  });

  it("reports a non-string text field", async () => {
    stubFetch(() => json({ text: 42, provider: "madlad" }));

    await assert.rejects(
      provider().translate(requestFor(TITLE, CONTENT), contextFor()),
      rejectsAsTransport(/no text/)
    );
  });

  it("refuses an empty translation rather than silently losing the paragraph", async () => {
    stubFetch(() => reply("   "));

    await assert.rejects(
      provider().translate(requestFor(TITLE, CONTENT), contextFor()),
      rejectsAsTransport(/empty translation/)
    );
  });

  it("refuses a foreign envelope — a /generate reply must never pass as MADLAD", async () => {
    // Shaped exactly like a valid reply except for the provider. Accepting it would
    // store a chat model's output under MADLAD's name and invalidate the comparison.
    stubFetch(() => json({ text: "Някакъв текст на български език тук.", provider: "ollama" }));

    await assert.rejects(
      provider().translate(requestFor(TITLE, CONTENT), contextFor()),
      rejectsAsTransport(/foreign envelope/)
    );
  });

  it("refuses a reply with no provider envelope at all", async () => {
    stubFetch(() => json({ text: "Някакъв текст на български език тук." }));

    await assert.rejects(
      provider().translate(requestFor(TITLE, CONTENT), contextFor()),
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

  it("names the segment that failed, so a 12-segment article is diagnosable", async () => {
    let n = 0;
    stubFetch(() => {
      n += 1;
      return n < 3 ? translated() : json({ error: "boom", provider: "madlad" }, 500);
    });

    await assert.rejects(
      provider().translate(requestFor(TITLE, CONTENT), contextFor()),
      rejectsAsTransport(/segment 3\/3/)
    );
  });
});

// ─── Budgets ──────────────────────────────────────────────────────────────────

describe("MadladTranslationProvider — budgets", () => {
  it("times out an attempt that outlives its budget", async () => {
    globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch;

    await assert.rejects(
      provider().translate(requestFor(TITLE, null), contextFor({ attemptTimeoutMs: 20 })),
      (err: unknown) => err instanceof TranslationTimeoutError
    );
  });

  it("stops mid-article when the ITEM deadline passes, instead of finishing the batch", async () => {
    // Every call is fine; the clock is what runs out. A per-segment engine must notice
    // between segments, or a slow worker overruns the item budget by a whole article.
    let clock = Date.now();
    stubFetch(() => {
      clock += 1_000;
      return translated();
    });

    await assert.rejects(
      provider().translate(
        requestFor(TITLE, CONTENT),
        contextFor({ now: () => new Date(clock), itemDeadlineMs: clock + 1_500 })
      ),
      (err: unknown) => err instanceof TranslationTimeoutError
    );
    assert.ok(requests.length < 3, "it must not have run every segment");
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

// ─── Bounded concurrency (TRANSLATION_MADLAD_CONCURRENCY) ─────────────────────
//
// Measured against the real production worker (2026-08-20), raising concurrency did
// NOT improve throughput — it measured WORSE than the fully-serialized case — so the
// default stays 1 (see DEFAULT_MADLAD_CONCURRENCY's comment). This suite proves the
// MECHANISM is correct for when a deployment's own worker measures differently:
// order is preserved regardless of completion order, the in-flight bound is real
// (not just structurally assumed), one failing segment still fails the whole
// article, the item deadline still stops new work, and concurrency 1 — the
// production default — is byte-for-byte the old sequential behaviour (already
// proven above: every existing test in this file runs at the default and is
// unmodified).
describe("MadladTranslationProvider — bounded concurrency", () => {
  const delayed = (text: string, ms: number): Promise<Response> =>
    new Promise((resolve) => setTimeout(() => resolve(reply(text)), ms));

  it("preserves source order in the reassembled article regardless of completion order", async () => {
    // "Gamma" answers FIRST (0ms), "Alpha" answers LAST (60ms) — the exact opposite of
    // source order — so a pass here can only mean reassembly is order-preserving.
    stubFetch(async (body) => {
      const text = String(body.text);
      if (text === "Alpha one.") return delayed("Преведено Алфа.", 60);
      if (text === "Beta two.") return delayed("Преведено Бета.", 30);
      if (text === "Gamma three.") return delayed("Преведено Гама.", 0);
      return translated();
    });

    const p = new MadladTranslationProvider(
      "http://w:3002",
      "k",
      "google/madlad400-3b-mt",
      "en",
      3
    );
    const result = await p.translate(
      requestFor(null, "Alpha one. Beta two. Gamma three."),
      contextFor()
    );

    assert.equal(result.translatedContent, "Преведено Алфа. Преведено Бета. Преведено Гама.");
  });

  it("never exceeds the configured concurrency, and actually reaches it", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    stubFetch(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight -= 1;
      return translated();
    });

    const p = new MadladTranslationProvider(
      "http://w:3002",
      "k",
      "google/madlad400-3b-mt",
      "en",
      2
    );
    await p.translate(requestFor(null, "One. Two. Three. Four. Five."), contextFor());

    assert.ok(maxInFlight <= 2, `expected at most 2 in flight, saw ${maxInFlight}`);
    assert.equal(
      maxInFlight,
      2,
      "concurrency 2 should actually reach 2 in flight, not silently stay at 1"
    );
  });

  it("a single failing segment rejects the WHOLE translation, with no partial content ever built", async () => {
    stubFetch(async (body) => {
      const text = String(body.text);
      if (text === "Beta two.") {
        await new Promise((r) => setTimeout(r, 5));
        return json({ error: "boom", provider: "madlad" }, 500);
      }
      await new Promise((r) => setTimeout(r, 25));
      return translated();
    });

    const p = new MadladTranslationProvider(
      "http://w:3002",
      "k",
      "google/madlad400-3b-mt",
      "en",
      3
    );
    await assert.rejects(
      p.translate(requestFor(null, "Alpha one. Beta two. Gamma three."), contextFor()),
      (err: unknown) => err instanceof TranslationTransportError && /500/.test(err.message)
    );
  });

  it("restores each segment's own protected value correctly, even completing out of order", async () => {
    const URL_A = "https://example.com/a";
    const URL_B = "https://example.com/b";
    const URL_C = "https://example.com/c";

    function echoingDelayed(body: Record<string, unknown>, ms: number): Promise<Response> {
      const text = String(body.text);
      const holders = text.match(/\[\[\d+\]\]/g) ?? [];
      const out =
        holders.length > 0
          ? `Преведено изречение с ${holders.join(" и ")} на български език.`
          : "Преведено изречение на български език.";
      return delayed(out, ms);
    }

    stubFetch(async (body) => {
      const text = String(body.text);
      // First sentence (carries URL_A) answers SLOWEST; last (carries URL_C) FASTEST —
      // reversed from source order, so a correct restoration can only come from
      // per-segment isolation, not from completion order.
      if (text.startsWith("Read")) return echoingDelayed(body, 60);
      if (text.startsWith("Visit")) return echoingDelayed(body, 30);
      return echoingDelayed(body, 0);
    });

    const p = new MadladTranslationProvider(
      "http://w:3002",
      "k",
      "google/madlad400-3b-mt",
      "en",
      3
    );
    const result = await p.translate(
      requestFor(null, `Read ${URL_A} today. Visit ${URL_B} next. See ${URL_C} also.`),
      contextFor()
    );

    const found = result.translatedContent?.match(/https:\/\/\S+/g) ?? [];
    assert.deepEqual(
      found.map((u) => u.replace(/[.,]$/, "")),
      [URL_A, URL_B, URL_C],
      "each URL must land back in ITS OWN sentence, in source order"
    );
  });

  it("still stops before starting new work once the item deadline passes", async () => {
    let clock = Date.now();
    stubFetch(() => {
      clock += 1_000;
      return translated();
    });

    const p = new MadladTranslationProvider(
      "http://w:3002",
      "k",
      "google/madlad400-3b-mt",
      "en",
      2
    );
    await assert.rejects(
      p.translate(
        requestFor(null, "One. Two. Three. Four. Five. Six."),
        contextFor({ now: () => new Date(clock), itemDeadlineMs: clock + 2_500 })
      ),
      (err: unknown) => err instanceof TranslationTimeoutError
    );
    assert.ok(requests.length < 6, "must not have run every segment past the deadline");
  });

  it("concurrency 1 (the production default) reproduces the exact prior sequential order", async () => {
    stubFetch(translated);
    // No 5th argument — exercises the DEFAULT, exactly like every test above this suite.
    const p = new MadladTranslationProvider("http://w:3002", "k", "google/madlad400-3b-mt");
    await p.translate(requestFor(TITLE, CONTENT), contextFor());

    assert.deepEqual(
      requests.map((r) => r.body.text),
      [TITLE, "A fire extinguisher can last between 5 and 15 years.", "Check the pressure gauge."]
    );
  });
});
