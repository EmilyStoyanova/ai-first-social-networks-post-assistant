import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OllamaTranslationProvider } from "./ollama-translation.provider";
import type { ArticleTranslationContext } from "./translation-provider";
import { buildTranslationPrompts, TranslationParseError } from "@/lib/ai/feed-item-translation";
import { GenerationTracer } from "@/lib/generation-trace/tracer";
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
