import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_TRANSLATION_ATTEMPTS,
  MAX_TRANSLATION_CONTENT_CHARS,
  buildTranslationPrompts,
  capTranslationContent,
  computeTranslationBackoff,
  computeTranslationHash,
  estimateTokenCount,
  isTranslatableSourceType,
  MAX_TRANSLATION_OUTPUT_TOKENS,
  parseTranslationResponse,
  requiresTranslationWork,
  resolveFeedItemContent,
  resolveTranslationConfig,
  TranslationParseError,
  TRANSLATION_JSON_SCHEMA,
  type TranslationConfig,
} from "./feed-item-translation";

// ─── computeTranslationHash ───────────────────────────────────────────────────

describe("computeTranslationHash", () => {
  it("is stable for identical input", () => {
    const a = computeTranslationHash("Title", "Body", "bg");
    const b = computeTranslationHash("Title", "Body", "bg");
    assert.equal(a, b);
  });

  it("changes when the title, the content, or the target language changes", () => {
    const base = computeTranslationHash("Title", "Body", "bg");
    assert.notEqual(base, computeTranslationHash("Other", "Body", "bg"));
    assert.notEqual(base, computeTranslationHash("Title", "Other", "bg"));
    assert.notEqual(base, computeTranslationHash("Title", "Body", "en"));
  });

  it("treats null title/content as empty rather than throwing", () => {
    assert.equal(computeTranslationHash(null, null, "bg"), computeTranslationHash("", "", "bg"));
  });
});

// ─── requiresTranslationWork ──────────────────────────────────────────────────

describe("requiresTranslationWork", () => {
  const enabled: TranslationConfig = { enabled: true, targetLanguage: "bg" };
  const disabled: TranslationConfig = { enabled: false, targetLanguage: "bg" };
  const HASH = "hash-current";
  const OLD_HASH = "hash-old";

  it("(1) counts a newly created translatable item", () => {
    assert.equal(requiresTranslationWork(enabled, HASH, true, undefined), true);
  });

  it("(2) does NOT count an unchanged completed item", () => {
    const existing = { translationHash: HASH, translationStatus: "completed", translationAttemptCount: 1 };
    assert.equal(requiresTranslationWork(enabled, HASH, false, existing), false);
  });

  it("(3) counts an unchanged pending item (still owed)", () => {
    const existing = { translationHash: HASH, translationStatus: "pending", translationAttemptCount: 1 };
    assert.equal(requiresTranslationWork(enabled, HASH, false, existing), true);
  });

  it("(4) counts a changed (reopened) completed item — hash differs", () => {
    const existing = { translationHash: OLD_HASH, translationStatus: "completed", translationAttemptCount: 1 };
    assert.equal(requiresTranslationWork(enabled, HASH, false, existing), true);
  });

  it("(5) does NOT count a disabled source (created or updated), nor a non-translatable source", () => {
    assert.equal(requiresTranslationWork(disabled, HASH, true, undefined), false);
    const skipped = { translationHash: HASH, translationStatus: "skipped", translationAttemptCount: 0 };
    assert.equal(requiresTranslationWork(disabled, HASH, false, skipped), false);
    // cfg null → non-translatable source type (prompt/product_page/calendar).
    assert.equal(requiresTranslationWork(null, HASH, true, undefined), false);
  });

  it("counts an unchanged failed item under the attempt cap, but not once exhausted", () => {
    const under = {
      translationHash: HASH,
      translationStatus: "failed",
      translationAttemptCount: MAX_TRANSLATION_ATTEMPTS - 1,
    };
    const exhausted = {
      translationHash: HASH,
      translationStatus: "failed",
      translationAttemptCount: MAX_TRANSLATION_ATTEMPTS,
    };
    assert.equal(requiresTranslationWork(enabled, HASH, false, under), true);
    assert.equal(requiresTranslationWork(enabled, HASH, false, exhausted), false);
  });

  it("counts an existing item with no prior hash (never translated) as reopened work", () => {
    const noHash = { translationHash: null, translationStatus: "pending", translationAttemptCount: 0 };
    assert.equal(requiresTranslationWork(enabled, HASH, false, noHash), true);
  });
});

// ─── computeTranslationBackoff ────────────────────────────────────────────────

describe("computeTranslationBackoff", () => {
  const NOW = new Date("2026-07-16T12:00:00.000Z");
  const MIN = 60 * 1000;

  it("follows the 5m / 30m / 2h / 8h / 24h schedule", () => {
    const expected = [5 * MIN, 30 * MIN, 120 * MIN, 480 * MIN, 1440 * MIN];
    expected.forEach((delay, i) => {
      const at = computeTranslationBackoff(i + 1, NOW);
      assert.equal(at.getTime() - NOW.getTime(), delay, `attempt ${i + 1}`);
    });
  });

  it("caps at 24h beyond the last attempt", () => {
    const at = computeTranslationBackoff(MAX_TRANSLATION_ATTEMPTS + 3, NOW);
    assert.equal(at.getTime() - NOW.getTime(), 1440 * MIN);
  });

  it("never schedules a retry in the past", () => {
    assert.ok(computeTranslationBackoff(1, NOW).getTime() > NOW.getTime());
  });
});

// ─── resolveTranslationConfig ─────────────────────────────────────────────────

describe("resolveTranslationConfig", () => {
  it("defaults the target to the company content language", () => {
    const cfg = resolveTranslationConfig("rss", { translateEnabled: true }, "bg");
    assert.deepEqual(cfg, { enabled: true, targetLanguage: "bg" });
  });

  it("honours an explicit target over the company language", () => {
    const cfg = resolveTranslationConfig(
      "rss",
      { translateEnabled: true, translateToLanguage: "en" },
      "bg"
    );
    assert.deepEqual(cfg, { enabled: true, targetLanguage: "en" });
  });

  it("is disabled when the flag is absent or not exactly true", () => {
    assert.equal(resolveTranslationConfig("rss", {}, "bg").enabled, false);
    assert.equal(resolveTranslationConfig("rss", { translateEnabled: "yes" }, "bg").enabled, false);
    assert.equal(resolveTranslationConfig("rss", null, "bg").enabled, false);
  });

  it("ignores translateEnabled on non-RSS source types", () => {
    for (const type of ["prompt", "product_page", "calendar_event"]) {
      const cfg = resolveTranslationConfig(type, { translateEnabled: true }, "bg");
      assert.equal(cfg.enabled, false, type);
    }
  });

  it("classifies only rss as translatable", () => {
    assert.ok(isTranslatableSourceType("rss"));
    assert.ok(!isTranslatableSourceType("prompt"));
  });
});

// ─── resolveFeedItemContent ───────────────────────────────────────────────────

describe("resolveFeedItemContent", () => {
  const ORIGINAL = { title: "Original title", content: "Original content" };

  it("uses the translation once completed", () => {
    const r = resolveFeedItemContent({
      ...ORIGINAL,
      translatedTitle: "Заглавие",
      translatedContent: "Съдържание",
      translationStatus: "completed",
    });
    assert.deepEqual(r, { title: "Заглавие", content: "Съдържание", usedTranslation: true });
  });

  it("falls back to the original for every non-completed status", () => {
    for (const status of ["pending", "failed", "skipped", null, undefined]) {
      const r = resolveFeedItemContent({
        ...ORIGINAL,
        translatedTitle: "Заглавие",
        translatedContent: "Съдържание",
        translationStatus: status,
      });
      assert.deepEqual(
        r,
        { ...ORIGINAL, usedTranslation: false },
        `status ${String(status)} must not use the translation`
      );
    }
  });

  it("falls back when the status is completed but no translated content exists", () => {
    const r = resolveFeedItemContent({
      ...ORIGINAL,
      translatedTitle: null,
      translatedContent: null,
      translationStatus: "completed",
    });
    assert.deepEqual(r, { ...ORIGINAL, usedTranslation: false });
  });

  it("keeps a completed translation whose source article had no title", () => {
    const r = resolveFeedItemContent({
      title: null,
      content: "Original content",
      translatedTitle: null,
      translatedContent: "Съдържание",
      translationStatus: "completed",
    });
    assert.deepEqual(r, { title: null, content: "Съдържание", usedTranslation: true });
  });
});

// ─── parseTranslationResponse ─────────────────────────────────────────────────

describe("parseTranslationResponse", () => {
  it("parses a plain (schema-constrained) JSON object without needing repair", () => {
    const r = parseTranslationResponse('{"title":"Заглавие","content":"Съдържание"}');
    assert.deepEqual(r, {
      translatedTitle: "Заглавие",
      translatedContent: "Съдържание",
      usedRepair: false,
    });
  });

  it("preserves quotes and newlines inside content (valid JSON string escapes)", () => {
    const raw = '{"title":"Той каза \\"здравей\\"","content":"Първи ред\\nВтори ред"}';
    const r = parseTranslationResponse(raw);
    assert.equal(r.translatedTitle, 'Той каза "здравей"');
    assert.equal(r.translatedContent, "Първи ред\nВтори ред");
    assert.equal(r.usedRepair, false);
  });

  it("tolerates code fences and surrounding prose", () => {
    const raw = 'Sure!\n```json\n{"title":"Заглавие","content":"Съдържание"}\n```';
    const r = parseTranslationResponse(raw);
    assert.equal(r.translatedTitle, "Заглавие");
  });

  it("salvages a reply truncated just before its closing brace (the real qwen3 output)", () => {
    // Observed live: the worker returns HTTP 200 with a complete title + content but no
    // trailing "}" — both string values are terminated, only the close brace is missing.
    const truncated = '{\n  "title": "Заглавие",\n  "content": "Пълно съдържание на статията."';
    const r = parseTranslationResponse(truncated);
    assert.deepEqual(r, {
      translatedTitle: "Заглавие",
      translatedContent: "Пълно съдържание на статията.",
      // The primary JSON.parse failed and the defensive repair salvaged it — the fallback
      // still works, and it flags that it had to be used.
      usedRepair: true,
    });
  });

  it("still rejects a reply cut off mid-string (an unterminated value is not salvaged)", () => {
    // Distinct from the missing-brace case: the content value itself is truncated, so the
    // string never closes. Repairing this would fabricate a partial translation — it must fail.
    assert.throws(
      () => parseTranslationResponse('{"title":"Заглавие","content":"Частичен превод, който бе отря'),
      TranslationParseError
    );
  });

  it("does not turn a trailing-comma truncation into valid output", () => {
    assert.throws(
      () => parseTranslationResponse('{"title":"x","content":"y",'),
      TranslationParseError
    );
  });

  it("ignores braces inside translated text when locating the object", () => {
    const r = parseTranslationResponse('{"title":"Кодът {x} работи","content":"Виж {y} тук."}');
    assert.equal(r.translatedTitle, "Кодът {x} работи");
    assert.equal(r.translatedContent, "Виж {y} тук.");
  });

  it("normalises a null/empty title to null", () => {
    assert.equal(parseTranslationResponse('{"title":null,"content":"x"}').translatedTitle, null);
    assert.equal(parseTranslationResponse('{"title":"  ","content":"x"}').translatedTitle, null);
  });

  it("rejects malformed JSON", () => {
    assert.throws(() => parseTranslationResponse("not json at all"), TranslationParseError);
    assert.throws(() => parseTranslationResponse('{"title":"x",'), TranslationParseError);
  });

  it("rejects a missing or empty content field", () => {
    assert.throws(() => parseTranslationResponse('{"title":"x"}'), TranslationParseError);
    assert.throws(
      () => parseTranslationResponse('{"title":"x","content":"  "}'),
      TranslationParseError
    );
  });

  it("rejects a missing title field as a schema-validation failure", () => {
    // `title` is required by TRANSLATION_JSON_SCHEMA; a reply that omits the key entirely
    // is the wrong shape (distinct from an article with an empty title, which sends "").
    const err = parseTranslationResponse.bind(null, '{"content":"Съдържание"}');
    assert.throws(err, (e: unknown) => {
      assert.ok(e instanceof TranslationParseError);
      assert.equal(e.reason, "schema_validation");
      return true;
    });
  });

  it("tags malformed JSON with reason invalid_json", () => {
    assert.throws(() => parseTranslationResponse("not json at all"), (e: unknown) => {
      assert.ok(e instanceof TranslationParseError);
      assert.equal(e.reason, "invalid_json");
      return true;
    });
  });

  it("rejects Serbian/Macedonian-looking output for a Bulgarian target", () => {
    // Macedonian uses "ј" (and Serbian "ђ/ћ/џ"); none exist in the Bulgarian alphabet, so a
    // reply carrying them is a language drift and must be rejected as wrong_language.
    const macedonian = '{"title":"Наслов","content":"Ова е текст напишан на македонски јазик."}';
    assert.throws(() => parseTranslationResponse(macedonian, "bg"), (e: unknown) => {
      assert.ok(e instanceof TranslationParseError);
      assert.equal(e.reason, "wrong_language");
      return true;
    });

    const serbian = '{"title":"Наслов","content":"Ђорђе је отишао кући."}';
    assert.throws(
      () => parseTranslationResponse(serbian, "bg"),
      (e: unknown) => e instanceof TranslationParseError && e.reason === "wrong_language"
    );
  });

  it("accepts clean Bulgarian (including native ъ/я/ю) for a Bulgarian target", () => {
    const bg = '{"title":"Заглавие","content":"Това е текст на български език — ъгъл, ютия, ябълка."}';
    const r = parseTranslationResponse(bg, "bg");
    assert.equal(r.translatedContent, "Това е текст на български език — ъгъл, ютия, ябълка.");
  });

  it("does not language-check when no target language is supplied", () => {
    // The wrong-language guard only runs for Bulgarian targets; without a target it is a no-op.
    const macedonian = '{"title":"Наслов","content":"Ова е на македонски јазик."}';
    assert.equal(parseTranslationResponse(macedonian).translatedContent, "Ова е на македонски јазик.");
  });
});

// ─── TRANSLATION_JSON_SCHEMA ──────────────────────────────────────────────────

describe("TRANSLATION_JSON_SCHEMA", () => {
  it("is the strict {title, content} object schema handed to Ollama's format field", () => {
    assert.deepEqual(TRANSLATION_JSON_SCHEMA, {
      type: "object",
      properties: {
        title: { type: "string" },
        content: { type: "string" },
      },
      required: ["title", "content"],
      additionalProperties: false,
    });
  });
});

// ─── buildTranslationPrompts ──────────────────────────────────────────────────

describe("buildTranslationPrompts", () => {
  it("names the target language and demands a single, complete JSON object only", () => {
    const { systemPrompt, userPrompt } = buildTranslationPrompts("T", "C", "bg");
    assert.match(systemPrompt, /into Bulgarian/);
    // Firmer than "return JSON": one complete object, closed, with nothing else around it —
    // this is what keeps a reasoning model from emitting prose or an unclosed object.
    assert.match(systemPrompt, /ONLY a single, complete JSON object/);
    assert.match(systemPrompt, /closing brace/);
    assert.match(systemPrompt, /no reasoning/);
    assert.match(userPrompt, /Title: T/);
    assert.match(userPrompt, /Content: C/);
  });

  it("adds the Bulgarian language guardrails for a Bulgarian target", () => {
    const { systemPrompt } = buildTranslationPrompts("T", "C", "bg");
    assert.match(systemPrompt, /natural, fluent Bulgarian/);
    assert.match(systemPrompt, /Bulgarian Cyrillic/);
    assert.match(systemPrompt, /Do NOT use Serbian, Macedonian, Russian/);
    assert.match(systemPrompt, /Keep proper names, URLs, brand names/);
  });

  it("omits the Bulgarian-specific guardrails for a non-Bulgarian target", () => {
    const { systemPrompt } = buildTranslationPrompts("T", "C", "en");
    assert.match(systemPrompt, /into English/);
    assert.ok(!/Bulgarian Cyrillic/.test(systemPrompt));
  });

  it("renders a null title as empty rather than the string 'null'", () => {
    const { userPrompt } = buildTranslationPrompts(null, "C", "bg");
    assert.match(userPrompt, /Title: \n/);
    assert.ok(!userPrompt.includes("null"));
  });

  it("caps an over-long body but never the title (bounds generation cost)", () => {
    const longBody = "word ".repeat(2000); // ~10k chars, over the cap
    const { userPrompt } = buildTranslationPrompts("Full Title Kept", longBody, "bg");

    // Title survives in full.
    assert.match(userPrompt, /Title: Full Title Kept/);
    // The prompt body is bounded to roughly the cap (+ marker + "Content: " prefix), not 10k.
    assert.ok(userPrompt.length < MAX_TRANSLATION_CONTENT_CHARS + 200);
    assert.match(userPrompt, /\[…\]$/);
  });

  it("leaves a body at or under the cap untouched", () => {
    const body = "x".repeat(MAX_TRANSLATION_CONTENT_CHARS);
    const { userPrompt } = buildTranslationPrompts("T", body, "bg");
    assert.match(userPrompt, new RegExp(`Content: ${body}$`));
    assert.ok(!userPrompt.includes("[…]"));
  });
});

// ─── output bound + token estimate ─────────────────────────────────────────────

describe("MAX_TRANSLATION_OUTPUT_TOKENS", () => {
  it("is a finite positive bound (never unlimited) that clears a full capped translation", () => {
    assert.ok(Number.isFinite(MAX_TRANSLATION_OUTPUT_TOKENS));
    assert.ok(MAX_TRANSLATION_OUTPUT_TOKENS > 0);
    // The ~3000-char body needs well under this even at a pessimistic ~1.5 chars/token.
    assert.ok(MAX_TRANSLATION_OUTPUT_TOKENS >= 2048, "must leave headroom for a real translation");
  });
});

describe("estimateTokenCount", () => {
  it("estimates ~4 chars per token and never returns a fraction", () => {
    assert.equal(estimateTokenCount(""), 0);
    assert.equal(estimateTokenCount("abcd"), 1);
    assert.equal(estimateTokenCount("abcde"), 2); // rounds up
  });
});

// ─── capTranslationContent ────────────────────────────────────────────────────

describe("capTranslationContent", () => {
  it("returns short content and null unchanged", () => {
    assert.equal(capTranslationContent(null), null);
    assert.equal(capTranslationContent("short"), "short");
  });

  it("cuts at a word boundary and appends a neutral marker", () => {
    const capped = capTranslationContent("alpha beta gamma delta", 12)!;
    assert.ok(capped.endsWith(" […]"));
    // Cut backed up to the last space within the window → no split word.
    assert.ok(!/\bgam$/.test(capped));
    assert.ok(capped.startsWith("alpha beta"));
  });

  it("hard-cuts when there is no late whitespace to back up to", () => {
    const capped = capTranslationContent("abcdefghijklmnop", 10)!;
    assert.equal(capped, "abcdefghij […]");
  });
});
