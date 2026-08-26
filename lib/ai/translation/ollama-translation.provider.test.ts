import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OllamaTranslationProvider } from "./ollama-translation.provider";
import type { ArticleTranslationContext } from "./translation-provider";
import { TranslationPartialProgressError } from "./translation-provider";
import { OLLAMA_CHUNK_MAX_CHARS, OLLAMA_CHUNK_MAX_PROTECTED_TOKENS } from "./ollama-chunking";
import { protectTokens } from "./protected-tokens";
import { buildTranslationPrompts, TranslationParseError } from "@/lib/ai/feed-item-translation";
import { GenerationTracer } from "@/lib/generation-trace/tracer";
import type { PersistableRun } from "@/lib/generation-trace/store";
import type { ILlmProvider, LlmRequest, LlmResponse } from "@/lib/ai/types";

/**
 * Protected-token validation for the prompt-based (Ollama/Qwen) engine.
 *
 * Mirrors the guarantee `protectTokens`/`restoreTokens` already give MADLAD (see
 * protected-tokens.ts and madlad-translation.provider.test.ts): a URL, e-mail address,
 * or identifier (model name, SKU, version string) held out of the decoder must come
 * back byte-exact, or the reply is rejected — never silently trusted because the
 * prompt merely asked nicely. The mechanism is the SAME module, reused rather than
 * duplicated; what differs from MADLAD is only that a bad result here retries through
 * the engine's own regeneration loop (a fresh sample, not a deterministic repeat).
 */

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

function requestFor(title: string | null, content: string | null, targetLang = "bg") {
  const prompts = buildTranslationPrompts(title, content, targetLang);
  return {
    feedItemId: "item-1",
    url: "https://example.com/a",
    title,
    content,
    targetLang,
    mode: prompts.mode,
    prompts,
  };
}

/** A fake ILlmProvider that answers each successive call with the next reply in `replies`. */
function llmWithReplies(replies: readonly string[]): ILlmProvider & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    calls,
    generate: async (request: LlmRequest): Promise<LlmResponse> => {
      calls.push(request);
      const text = replies[Math.min(calls.length - 1, replies.length - 1)];
      return { text, raw: { call: calls.length } };
    },
  };
}

function provider(llm: ILlmProvider) {
  return new OllamaTranslationProvider(llm, "TEXT_WORKER", "qwen3.5:35b-a3b-q4_K_M");
}

describe("OllamaTranslationProvider — protected-token validation", () => {
  it("accepts a reply that reproduces every protected placeholder unchanged", async () => {
    const title = "Review: DCD-800 cordless drill";
    const content = "The DCD-800 is available at https://example.com/dcd-800 for $199.";
    const request = requestFor(title, content);

    // Sanity: the source really was protected before ever reaching the model.
    assert.equal(request.prompts.titleProtectedValues.length, 1);
    assert.equal(request.prompts.contentProtectedValues.length, 2);
    assert.match(request.prompts.userPrompt, /\[\[0\]\]/);

    const llm = llmWithReplies([
      JSON.stringify({
        title: "Преглед: [[0]] безжична бормашина",
        content: "[[0]] е наличен на [[1]] за $199.",
      }),
    ]);

    const result = await provider(llm).translate(request, contextFor());

    assert.equal(result.translatedTitle, "Преглед: DCD-800 безжична бормашина");
    assert.equal(
      result.translatedContent,
      "DCD-800 е наличен на https://example.com/dcd-800 за $199."
    );
    assert.equal(result.tries, 1, "a clean reply must not spend a retry");
  });

  it("repairs a mutated identifier by retrying — reusing the existing regeneration loop", async () => {
    const title = "DCD-800 review";
    const content = "The DCD-800 arrives next week.";
    const request = requestFor(title, content);

    const llm = llmWithReplies([
      // Try 1: the model "helpfully" transliterated the placeholder's content instead of
      // copying it through — a corrupted, not merely differently-worded, reply.
      JSON.stringify({
        title: "Преглед на ДЦД-800",
        content: "ДЦД-800 пристига следващата седмица.",
      }),
      // Try 2: a fresh sample gets it right.
      JSON.stringify({ title: "Преглед на [[0]]", content: "[[0]] пристига следващата седмица." }),
    ]);

    const result = await provider(llm).translate(request, contextFor());

    assert.equal(result.translatedTitle, "Преглед на DCD-800");
    assert.equal(result.translatedContent, "DCD-800 пристига следващата седмица.");
    assert.equal(result.tries, 2, "the repair must go through the SAME retry loop, spending a try");
    assert.equal(llm.calls.length, 2);
  });

  it("names the defect in the correction sent back to the model", async () => {
    const request = requestFor("DCD-800 review", "The DCD-800 arrives next week.");
    const llm = llmWithReplies([
      JSON.stringify({
        title: "Преглед на ДЦД-800",
        content: "ДЦД-800 пристига следващата седмица.",
      }),
      JSON.stringify({ title: "Преглед на [[0]]", content: "[[0]] пристига следващата седмица." }),
    ]);

    await provider(llm).translate(request, contextFor());

    assert.equal(llm.calls.length, 2);
    // The retry prompt (try 2) must name the placeholder defect, not just re-roll blindly.
    assert.match(llm.calls[1].userPrompt, /placeholder/i);
    assert.match(llm.calls[1].userPrompt, /\[\[n\]\]/);
  });

  it("rejects a reply that drops a protected identifier entirely, on every retry", async () => {
    const request = requestFor("DCD-800 review", "The DCD-800 arrives next week.");
    // Every attempt loses the placeholder — a defect no amount of retrying repairs.
    const llm = llmWithReplies([
      JSON.stringify({ title: "Преглед", content: "Пристига следващата седмица." }),
      JSON.stringify({ title: "Преглед", content: "Пристига следващата седмица." }),
      JSON.stringify({ title: "Преглед", content: "Пристига следващата седмица." }),
    ]);

    await assert.rejects(
      () => provider(llm).translate(request, contextFor()),
      (err: unknown) => {
        assert.ok(err instanceof TranslationParseError);
        assert.equal(err.reason, "protected_token");
        return true;
      }
    );
    // Exhausts the SAME retry ceiling every other defect uses — no bespoke recovery path.
    assert.equal(llm.calls.length, 3);
  });

  it("rejects a reply that duplicates a placeholder, then accepts a corrected retry", async () => {
    const request = requestFor("Update", "The DCD-800 arrives next week.");
    const llm = llmWithReplies([
      // Try 1: the same placeholder is emitted twice — an invented extra occurrence.
      JSON.stringify({
        title: "Актуализация",
        content: "[[0]] пристига [[0]] следващата седмица.",
      }),
      // Try 2: corrected.
      JSON.stringify({ title: "Актуализация", content: "[[0]] пристига следващата седмица." }),
    ]);

    const result = await provider(llm).translate(request, contextFor());

    assert.equal(result.translatedContent, "DCD-800 пристига следващата седмица.");
    assert.equal(llm.calls.length, 2, "the duplicated placeholder on try 1 must trigger a retry");
  });

  it("preserves a data-only field (nothing but a protected identifier) byte-exact", async () => {
    // A title that is, in its entirety, a product code — the article-level analogue of
    // MADLAD's per-segment "data-only" case (see isDataOnlySegment in segment-repair.ts):
    // there is no language in it at all, only a value that must round-trip untouched.
    const title = "DCD-800";
    const content = "This power tool works great outdoors.";
    const request = requestFor(title, content);

    assert.equal(request.prompts.titleProtectedValues.length, 1);
    assert.equal(request.prompts.titleProtectedValues[0].value, "DCD-800");
    // The whole title collapses to a bare placeholder — nothing else to translate.
    assert.match(request.prompts.userPrompt, /Title: \[\[0\]\]/);

    const llm = llmWithReplies([
      JSON.stringify({
        title: "[[0]]",
        content: "Този електрически инструмент работи чудесно на открито.",
      }),
    ]);

    const result = await provider(llm).translate(request, contextFor());

    assert.equal(result.translatedTitle, "DCD-800");
    assert.equal(result.tries, 1);
  });

  // ─── Reason-aware retry sampling ──────────────────────────────────────────
  //
  // The engine's escalating sampling schedule exists to break a decoding loop, and it is
  // counter-productive for exactly one defect: a dropped or duplicated placeholder.
  // Ollama's `repeat_penalty` down-weights tokens already in the recent context, and
  // "[", "]" and the digits ARE the most-repeated tokens in a placeholder-carrying body,
  // so raising it suppresses what the retry is asking for. These two tests pin that the
  // provider actually sends the reason-appropriate sampling — samplingForTry's own unit
  // tests cover the mapping, this covers the wiring.
  it("retries a protected_token rejection WITHOUT escalating temperature or repeat penalty", async () => {
    const request = requestFor("DCD-800 review", "The DCD-800 arrives next week.");
    const llm = llmWithReplies([
      // Try 1: the placeholder is gone entirely.
      JSON.stringify({ title: "Преглед", content: "Пристига следващата седмица." }),
      // Try 2: corrected.
      JSON.stringify({ title: "Преглед на [[0]]", content: "[[0]] пристига следващата седмица." }),
    ]);

    const result = await provider(llm).translate(request, contextFor());

    assert.equal(result.tries, 2);
    assert.equal(llm.calls.length, 2);
    assert.equal(llm.calls[0].temperature, 0, "try 1 is deterministic, as always");
    assert.equal(llm.calls[0].repeatPenalty, 1.1);
    assert.equal(
      llm.calls[1].temperature,
      0,
      "a protected_token retry must NOT sample away from the argmax placeholder token"
    );
    assert.equal(
      llm.calls[1].repeatPenalty,
      1.1,
      "a protected_token retry must NOT penalise the bracket/digit tokens it is asking for"
    );
  });

  it("still escalates on a repetition rejection — the case the schedule was built for", async () => {
    const request = requestFor("Ordinary headline", "Just plain prose, nothing to hold out.");
    assert.equal(request.prompts.contentProtectedValues.length, 0);

    const llm = llmWithReplies([
      // Try 1: a genuine decoding loop — valid JSON, right language, unusable text.
      JSON.stringify({ title: "Заглавие", content: "със със със със със със със" }),
      // Try 2: normal prose.
      JSON.stringify({
        title: "Заглавие",
        content: "Съвсем нормален текст за теста, който е достатъчно дълъг.",
      }),
    ]);

    const result = await provider(llm).translate(request, contextFor());

    assert.equal(result.tries, 2);
    assert.equal(llm.calls[1].temperature, 0.3, "anti-repetition escalation must be untouched");
    assert.equal(llm.calls[1].repeatPenalty, 1.2);
  });

  it("does not send any placeholder instructions when the source has nothing to protect", async () => {
    const request = requestFor("Ordinary headline", "Just plain prose, nothing to hold out.");
    assert.equal(request.prompts.titleProtectedValues.length, 0);
    assert.equal(request.prompts.contentProtectedValues.length, 0);
    assert.ok(!/\[\[n\]\]|placeholder/i.test(request.prompts.systemPrompt));
  });
});

// ─── The chunked path (Phase 3) ──────────────────────────────────────────────
//
// An article whose body exceeds MAX_TRANSLATION_CONTENT_CHARS/OLLAMA_CHUNK_MAX_CHARS
// used to lose everything past the cap: `request.prompts` (built by the caller with
// `buildTranslationPrompts`) truncated the body BEFORE it ever reached the model. The
// tests below exercise the routing decision and the chunked translation loop that now
// replaces that truncation — see ollama-chunking.ts and OllamaTranslationProvider's own
// class comment for the design.

/** A realistic, varied sentence pool — long paragraphs without the decoding-loop shape. */
const FILLER_SENTENCES = [
  "The new revision brings a redesigned chassis and a wider range of mounting options.",
  "Reviewers noted the improved thermal performance under sustained load.",
  "Early benchmarks show a measurable gain over the previous generation.",
  "The manufacturer says the change was driven directly by customer feedback.",
  "Supply constraints delayed the rollout in several regional markets.",
  "A firmware update addressed the initial reports of instability.",
  "The design team focused on reducing weight without weakening the frame.",
  "Independent testing largely confirmed the vendor's own published figures.",
  "Pricing remains close to the outgoing model despite the added features.",
  "Availability is expected to widen over the coming quarter.",
];

/** One paragraph of AT LEAST `minChars`, carrying `marker` near its start. */
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

/** Fixed Cyrillic filler well over the language-check's letter floor — never a real translation. */
const BG_FILLER = "Преведен текст на естествен и правилен български език за целите на теста.";

/**
 * A fake ILlmProvider tuned for the chunked path: it reads WHAT was asked (a title
 * call vs. a numbered "Passage N of M" chunk call) from the prompt shape itself,
 * carries through any `[[n]]` placeholder and any known marker word so a test can
 * verify a specific piece of source text reached (or did not reach) the model, and
 * can be told to fail every call for one marker's chunk to exercise the partial-
 * progress path.
 */
function chunkedLlm(
  opts: { markers?: readonly string[]; failMarker?: string } = {}
): ILlmProvider & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  const markers = opts.markers ?? [];
  return {
    calls,
    generate: async (request: LlmRequest): Promise<LlmResponse> => {
      calls.push(request);
      // The chunked TITLE call is `Title: ...` with no `Content:` line at all (mode
      // title_only, schema {title}). The OLD single-call "full" shape is ALSO
      // `Title: ...` but followed by a `Content:` line and needs BOTH keys — this
      // fake must answer that shape too, since the "stays on the single-call path"
      // test below sends exactly that.
      if (request.userPrompt.startsWith("Title: ") && !request.userPrompt.includes("\nContent: ")) {
        return { text: JSON.stringify({ title: BG_FILLER }) };
      }
      if (request.userPrompt.includes("\nContent: ")) {
        return { text: JSON.stringify({ title: BG_FILLER, content: BG_FILLER }) };
      }
      const body = request.userPrompt.replace(/^Passage \d+ of \d+:\n/, "");
      const marker = markers.find((m) => body.includes(m));
      if (marker && marker === opts.failMarker) {
        // A degenerate reply every single try — never a valid, acceptable translation.
        return { text: JSON.stringify({ content: "със със със със със със" }) };
      }
      const placeholders = body.match(/\[\[\d+\]\]/g) ?? [];
      const text = [BG_FILLER, marker ?? "", ...placeholders].filter(Boolean).join(" ");
      return { text: JSON.stringify({ content: text }) };
    },
  };
}

function contextForChunked(
  overrides: Partial<ArticleTranslationContext> = {}
): ArticleTranslationContext {
  return contextFor({ itemDeadlineMs: Date.now() + 300_000, itemTimeoutMs: 300_000, ...overrides });
}

/** Same request shape as `requestFor`, but `prompts` reflects a real (capped) build — the
 * chunked path must ignore it and work from `title`/`content` directly, exactly as MADLAD
 * already does; this fixture exists so a test can prove that ignoring is what happens. */
function chunkedRequestFor(title: string | null, content: string | null, targetLang = "bg") {
  return requestFor(title, content, targetLang);
}

describe("OllamaTranslationProvider — chunked translation of a large article", () => {
  it("routes a large article to multiple calls instead of truncating it to one", async () => {
    const content = [
      paragraphWithMarker("ALPHAMARKER", 2600, 0),
      paragraphWithMarker("BETAMARKER", 2600, 3),
      paragraphWithMarker("GAMMAMARKER", 2600, 6),
    ].join("\n\n");
    assert.ok(content.length > OLLAMA_CHUNK_MAX_CHARS * 2, "fixture must genuinely need chunking");

    const llm = chunkedLlm({ markers: ["ALPHAMARKER", "BETAMARKER", "GAMMAMARKER"] });
    const request = chunkedRequestFor("Title", content);
    const result = await provider(llm).translate(request, contextForChunked());

    // More than one call — the whole point: a single-call path could only ever have
    // sent (and lost) everything past the old ~3000-char cap.
    assert.ok(llm.calls.length > 1, `expected multiple calls, got ${llm.calls.length}`);
    // Every chunk call must be a "Passage N of M" call, never the old {title, content}
    // single-call shape.
    const chunkCalls = llm.calls.filter((c) => c.userPrompt.startsWith("Passage "));
    assert.ok(chunkCalls.length >= 2);

    // `mode: full` really does mean the whole article: every marker, from the FIRST
    // paragraph to the LAST, reached the model and made it into the final text.
    for (const marker of ["ALPHAMARKER", "BETAMARKER", "GAMMAMARKER"]) {
      assert.ok(
        chunkCalls.some((c) => c.userPrompt.includes(marker)),
        `${marker} was never sent to the model`
      );
      assert.ok(
        result.translatedContent?.includes(marker),
        `${marker} is missing from the final translated article`
      );
    }
  });

  it("keeps a short article on the single-call path — routing is unaffected below the ceiling", async () => {
    const content = "A short article that comfortably fits in one call.";
    const llm = chunkedLlm();
    const request = chunkedRequestFor("Title", content);
    await provider(llm).translate(request, contextForChunked());

    assert.equal(llm.calls.length, 1, "an article under the ceiling must never be chunked");
    assert.ok(
      llm.calls[0].userPrompt.startsWith("Title: "),
      "the OLD single-call shape, unchanged"
    );
  });

  it("reports one attempt but the TRUE number of model calls", async () => {
    const content = [paragraphWithMarker("A", 2600, 0), paragraphWithMarker("B", 2600, 3)].join(
      "\n\n"
    );
    const llm = chunkedLlm({ markers: ["A", "B"] });
    const result = await provider(llm).translate(
      chunkedRequestFor("Title", content),
      contextForChunked()
    );

    assert.equal(result.tries, 1, "the cross-run attempt is tracked by the caller, not this call");
    assert.equal(result.modelCalls, llm.calls.length);
    assert.ok((result.modelCalls ?? 0) > 1);
  });

  // ─── Protected tokens are LOCAL to each chunk ──────────────────────────────

  it("restarts protected-token indices at [[0]] for every chunk — no shared namespace", async () => {
    const content = [
      `Model ${"BE173BU"} leads the lineup. ` + paragraphWithMarker("FIRSTCHUNK", 2500, 0),
      `Model ${"SN850X9"} follows it. ` + paragraphWithMarker("SECONDCHUNK", 2500, 4),
    ].join("\n\n");

    const llm = chunkedLlm({ markers: ["FIRSTCHUNK", "SECONDCHUNK"] });
    const request = chunkedRequestFor("Title", content);
    const result = await provider(llm).translate(request, contextForChunked());

    const chunkCalls = llm.calls.filter((c) => c.userPrompt.startsWith("Passage "));
    const withIdentifier = chunkCalls.filter((c) => /\[\[0\]\]/.test(c.userPrompt));
    // BOTH chunks carry a placeholder at index 0 — a shared, article-wide numbering
    // would instead show [[0]] once and [[1]] (or higher) the second time.
    assert.ok(
      withIdentifier.length >= 2,
      `expected at least two chunks to independently start at [[0]], got ${withIdentifier.length} ` +
        `of ${chunkCalls.length}`
    );
    // And both identifiers survive restoration, byte-exact, in the final article.
    assert.ok(result.translatedContent?.includes("BE173BU"));
    assert.ok(result.translatedContent?.includes("SN850X9"));
  });

  // ─── Resume via translationProgress / context.resumeSegments ──────────────

  it("skips units already present in resumeSegments and never re-sends them", async () => {
    const content = [
      paragraphWithMarker("ALPHAMARKER", 2600, 0),
      paragraphWithMarker("BETAMARKER", 2600, 3),
    ].join("\n\n");
    const llm = chunkedLlm({ markers: ["ALPHAMARKER", "BETAMARKER"] });
    const request = chunkedRequestFor("Title", content);

    // A first call establishes how many units this article actually needs.
    const fresh = await provider(llm).translate(request, contextForChunked());
    const freshCalls = llm.calls.length;
    assert.ok(freshCalls >= 2);

    // A second, RESUMED call pretends the title and the first chunk are already done.
    const llm2 = chunkedLlm({ markers: ["ALPHAMARKER", "BETAMARKER"] });
    const resumeSegments = { title: "Заглавие вече преведено", "0": "Вече преведен текст." };
    const resumed = await provider(llm2).translate(request, contextForChunked({ resumeSegments }));

    assert.equal(
      llm2.calls.length,
      freshCalls - 2,
      "resuming must skip exactly the units already banked"
    );
    // The resumed text is exactly what was passed in — never re-translated.
    assert.ok(resumed.translatedContent?.startsWith("Вече преведен текст."));
    assert.equal(resumed.translatedTitle, "Заглавие вече преведено");
    void fresh;
  });

  // ─── Partial progress on a permanently-failing chunk ───────────────────────

  it("banks every earlier unit and throws TranslationPartialProgressError when one chunk exhausts its retries", async () => {
    const content = [
      paragraphWithMarker("ALPHAMARKER", 2600, 0),
      paragraphWithMarker("BETAMARKER", 2600, 3),
      paragraphWithMarker("GAMMAMARKER", 2600, 6),
    ].join("\n\n");
    const llm = chunkedLlm({
      markers: ["ALPHAMARKER", "BETAMARKER", "GAMMAMARKER"],
      failMarker: "BETAMARKER",
    });
    const request = chunkedRequestFor("Title", content);

    await assert.rejects(
      () => provider(llm).translate(request, contextForChunked()),
      (err: unknown) => {
        assert.ok(err instanceof TranslationPartialProgressError);
        // The title and the FIRST chunk (ALPHAMARKER) succeeded and must be banked —
        // this is what makes a later retry cheap: it never re-pays for them.
        assert.ok("title" in err.translatedSegments, "the title must be banked");
        assert.ok("0" in err.translatedSegments, "the first chunk must be banked");
        // The failing chunk itself, and anything after it, must NOT be banked.
        assert.equal(Object.keys(err.translatedSegments).length, 2);
        assert.ok(err.totalBatchCount >= 4, "title + 3 chunks");
        assert.equal(err.processedBatchCount, 2);
        return true;
      }
    );
  });

  it("a later attempt that resumes past the earlier failure never re-sends the banked units", async () => {
    const content = [
      paragraphWithMarker("ALPHAMARKER", 2600, 0),
      paragraphWithMarker("BETAMARKER", 2600, 3),
    ].join("\n\n");
    const request = chunkedRequestFor("Title", content);

    // First attempt: BETAMARKER's chunk fails permanently.
    const llm1 = chunkedLlm({ markers: ["ALPHAMARKER", "BETAMARKER"], failMarker: "BETAMARKER" });
    let banked: Record<string, string> = {};
    await assert.rejects(
      () => provider(llm1).translate(request, contextForChunked()),
      (err: unknown) => {
        assert.ok(err instanceof TranslationPartialProgressError);
        banked = err.translatedSegments;
        return true;
      }
    );
    assert.ok("title" in banked && "0" in banked, "title and the first chunk survived the failure");

    // Second attempt (a fresh cross-run try): the defect is gone this time, and the
    // banked units from the previous attempt are supplied as resumeSegments.
    const llm2 = chunkedLlm({ markers: ["ALPHAMARKER", "BETAMARKER"] });
    const result = await provider(llm2).translate(
      request,
      contextForChunked({ resumeSegments: banked })
    );

    // Only the ONE unit that failed last time is re-sent.
    assert.equal(llm2.calls.length, 1);
    assert.ok(result.translatedContent?.includes("BETAMARKER"));
  });

  // ─── The data-only chunk bypass, reused from segment-repair.ts ────────────

  it("bypasses a chunk that is nothing but protected identifiers — no model call, byte-exact", async () => {
    // A long run of bare identifier lines — a flattened spec table, the shape that
    // made MADLAD's own bypass necessary (see isDataOnlySegment's comment). Built
    // large enough to become its own chunk between two ordinary prose paragraphs.
    const specLines = Array.from({ length: 260 }, (_, i) => `SPEC${String(i).padStart(4, "0")}X`);
    const dataDump = specLines.join("\n");
    assert.ok(dataDump.length > 2200, "the data dump must be large enough to form its own chunk");

    const content = [
      paragraphWithMarker("BEFOREMARKER", 2600, 0),
      dataDump,
      paragraphWithMarker("AFTERMARKER", 2600, 5),
    ].join("\n\n");

    const llm = chunkedLlm({ markers: ["BEFOREMARKER", "AFTERMARKER"] });
    const request = chunkedRequestFor("Title", content);
    const result = await provider(llm).translate(request, contextForChunked());

    // The raw spec lines survive verbatim in the output — bypassed, not mistranslated.
    assert.ok(result.translatedContent?.includes("SPEC0000X"));
    assert.ok(result.translatedContent?.includes("SPEC0259X"));
    // And no call sent to the model ever carried this data dump's own text — it was
    // never sent at all, not even as placeholders.
    for (const call of llm.calls) {
      assert.ok(!call.userPrompt.includes("SPEC0000X"));
    }
  });

  // ─── Trace fields (requirement: chunk-level diagnostics must be visible) ──

  it("records original size, chunk count and per-chunk sizes on the trace", async () => {
    const content = [
      paragraphWithMarker("ALPHAMARKER", 2600, 0),
      paragraphWithMarker("BETAMARKER", 2600, 3),
    ].join("\n\n");
    const runs: PersistableRun[] = [];
    const tracer = GenerationTracer.start({
      kind: "translation",
      trigger: "system",
      store: { saveRun: async (run) => void runs.push(run) },
      newId: () => "run-ollama-chunked",
    });

    const llm = chunkedLlm({ markers: ["ALPHAMARKER", "BETAMARKER"] });
    await provider(llm).translate(
      chunkedRequestFor("Title", content),
      contextForChunked({ tracer })
    );
    await tracer.flush();

    const promptStep = runs[0].steps.find(
      (s) =>
        s.type === "prompt" &&
        (s.metadata as Record<string, unknown> | undefined)?.engine === "ollama"
    );
    assert.ok(promptStep, "expected a chunk-plan prompt step");
    const meta = promptStep!.metadata as Record<string, unknown>;
    assert.equal(meta.originalChars, content.length);
    assert.ok((meta.chunkCount as number) >= 2);
    assert.ok(Array.isArray(meta.chunkSizes));
    assert.equal(meta.resumedUnits, 0);
    assert.equal(meta.totalUnits, (meta.chunkCount as number) + 1); // + the title

    const finalStep = runs[0].steps.find(
      (s) =>
        s.type === "parsed_result" &&
        (s.metadata as Record<string, unknown> | undefined)?.engine === "ollama"
    );
    assert.ok(finalStep, "expected a chunked parsed_result step");
    const finalMeta = finalStep!.metadata as Record<string, unknown>;
    assert.ok((finalMeta.translatedChars as number) > 0);
    assert.equal(finalMeta.modelCalls, llm.calls.length);
  });
});

// ─── Routing on protected-token density alone (Phase 4) ──────────────────────
//
// The reported live failure: a SHORT article (well under OLLAMA_CHUNK_MAX_CHARS) that
// nonetheless carries more protected-token placeholders than one call can reliably
// round-trip. These tests exercise the routing decision and the per-chunk invariant
// end to end through the provider, on a fixture the char-only routing would have kept
// on the single-call path entirely.

/** Distinct, realistic hardware identifiers — enough to exceed the token ceiling in a
 *  body that stays well under the character ceiling. */
const DENSE_TECH_IDENTIFIERS = [
  "BE173BU",
  "7700X3D",
  "5800X3D",
  "X670E",
  "B650E",
  "RTX-4090",
  "RTX-4080",
  "DDR5-6000",
  "DDR5-5600",
  "SN850X9",
  "SN770X2",
  "PCIe-5.0",
];

function denseTechnicalContent(): string {
  return DENSE_TECH_IDENTIFIERS.map((id) => `The ${id} performed well in our benchmarks.`).join(
    " "
  );
}

describe("OllamaTranslationProvider — routing on protected-token density alone", () => {
  it("routes a SHORT article to multiple calls when it is protected-token-dense", async () => {
    const content = denseTechnicalContent();
    assert.ok(
      content.length < OLLAMA_CHUNK_MAX_CHARS,
      `fixture must stay under the char ceiling, got ${content.length}`
    );
    const tokenCount = protectTokens(content).values.length;
    assert.ok(
      tokenCount > OLLAMA_CHUNK_MAX_PROTECTED_TOKENS,
      `fixture only carries ${tokenCount} protected tokens`
    );

    const llm = chunkedLlm();
    const request = chunkedRequestFor("Title", content);
    const result = await provider(llm).translate(request, contextForChunked());

    const chunkCalls = llm.calls.filter((c) => c.userPrompt.startsWith("Passage "));
    assert.ok(
      chunkCalls.length > 1,
      `token density alone must trigger chunking, got ${chunkCalls.length} chunk call(s)`
    );
    for (const id of DENSE_TECH_IDENTIFIERS) {
      assert.ok(
        result.translatedContent?.includes(id),
        `${id} is missing from the final translated article`
      );
    }
  });

  it("never sends a single chunk call carrying more placeholders than the ceiling", async () => {
    const content = denseTechnicalContent();
    const llm = chunkedLlm();
    await provider(llm).translate(chunkedRequestFor("Title", content), contextForChunked());

    const chunkCalls = llm.calls.filter((c) => c.userPrompt.startsWith("Passage "));
    assert.ok(chunkCalls.length > 0);
    for (const call of chunkCalls) {
      const placeholderCount = (call.userPrompt.match(/\[\[\d+\]\]/g) ?? []).length;
      assert.ok(
        placeholderCount <= OLLAMA_CHUNK_MAX_PROTECTED_TOKENS,
        `a chunk call carried ${placeholderCount} placeholders, over the ${OLLAMA_CHUNK_MAX_PROTECTED_TOKENS} ceiling`
      );
    }
  });

  it("resumes correctly when routing was triggered by protected-token density, not size", async () => {
    const content = denseTechnicalContent();
    const llm = chunkedLlm();
    const request = chunkedRequestFor("Title", content);

    const fresh = await provider(llm).translate(request, contextForChunked());
    const freshCalls = llm.calls.length;
    assert.ok(freshCalls >= 2, "the dense fixture must need more than one call");

    const llm2 = chunkedLlm();
    const resumeSegments = { title: "Заглавие вече преведено", "0": "Вече преведен текст." };
    const resumed = await provider(llm2).translate(request, contextForChunked({ resumeSegments }));

    assert.equal(
      llm2.calls.length,
      freshCalls - 2,
      "resuming must skip exactly the units already banked"
    );
    assert.ok(resumed.translatedContent?.startsWith("Вече преведен текст."));
    assert.equal(resumed.translatedTitle, "Заглавие вече преведено");
    void fresh;
  });

  it("keeps a short, LOW-density article on the single-call path — routing is unaffected", async () => {
    const content = "The BE173BU is a competent monitor for the price, with few complaints.";
    assert.ok(protectTokens(content).values.length <= OLLAMA_CHUNK_MAX_PROTECTED_TOKENS);

    // A single-call reply that faithfully echoes back whatever placeholders the prompt
    // carried — chunkedLlm's own single-call branch is fixed BG_FILLER text with no
    // placeholders at all, which only suits the ZERO-protected-token fixture the other
    // single-call test above uses.
    const calls: LlmRequest[] = [];
    const llm: ILlmProvider & { calls: LlmRequest[] } = {
      calls,
      generate: async (request) => {
        calls.push(request);
        const placeholders = request.userPrompt.match(/\[\[\d+\]\]/g) ?? [];
        return {
          text: JSON.stringify({
            title: BG_FILLER,
            content: [BG_FILLER, ...placeholders].join(" "),
          }),
        };
      },
    };
    const request = chunkedRequestFor("Title", content);
    await provider(llm).translate(request, contextForChunked());

    assert.equal(llm.calls.length, 1, "a sparse short article must never be chunked");
    assert.ok(llm.calls[0].userPrompt.startsWith("Title: "));
  });
});
