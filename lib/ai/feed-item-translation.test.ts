import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_TRANSLATION_ATTEMPTS,
  MAX_TRANSLATION_CONTENT_CHARS,
  MIN_REPAIRED_CONTENT_CHARS,
  MIN_TRANSLATION_CONTENT_CHARS,
  MIN_TRANSLATION_ITEM_BUDGET_MS,
  sanitiseTranslationContent,
  shrinkTranslationContentBudget,
  TRANSLATION_TITLE_JSON_SCHEMA,
  assessBulgarian,
  buildTranslationPrompts,
  buildTranslationRetryPrompt,
  capTranslationContent,
  classifyTranslationInput,
  computeTranslationBackoff,
  computeTranslationHash,
  detectRepetition,
  estimateTokenCount,
  isRetriableParseFailure,
  isTranslatableSourceType,
  MAX_TRANSLATION_OUTPUT_TOKENS,
  MAX_TRANSLATION_RETRIES,
  parseTranslationResponse,
  samplingForTry,
  TRANSLATION_ATTEMPT_TIMEOUT_MS,
  TRANSLATION_ITEM_TIMEOUT_MS,
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
    const existing = {
      translationHash: HASH,
      translationStatus: "completed",
      translationAttemptCount: 1,
    };
    assert.equal(requiresTranslationWork(enabled, HASH, false, existing), false);
  });

  it("(3) counts an unchanged pending item (still owed)", () => {
    const existing = {
      translationHash: HASH,
      translationStatus: "pending",
      translationAttemptCount: 1,
    };
    assert.equal(requiresTranslationWork(enabled, HASH, false, existing), true);
  });

  it("(4) counts a changed (reopened) completed item — hash differs", () => {
    const existing = {
      translationHash: OLD_HASH,
      translationStatus: "completed",
      translationAttemptCount: 1,
    };
    assert.equal(requiresTranslationWork(enabled, HASH, false, existing), true);
  });

  it("(5) does NOT count a disabled source (created or updated), nor a non-translatable source", () => {
    assert.equal(requiresTranslationWork(disabled, HASH, true, undefined), false);
    const skipped = {
      translationHash: HASH,
      translationStatus: "skipped",
      translationAttemptCount: 0,
    };
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
    const noHash = {
      translationHash: null,
      translationStatus: "pending",
      translationAttemptCount: 0,
    };
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

  it("uses a title-only translation's title while keeping the original body", () => {
    // A body-less article is translated as a title only, so there is no translated body to
    // use — but the translated title is real and the original article stays the source.
    const r = resolveFeedItemContent({
      title: "Original title",
      content: null,
      translatedTitle: "Заглавие",
      translatedContent: null,
      translationStatus: "completed",
    });
    assert.deepEqual(r, { title: "Заглавие", content: null, usedTranslation: true });
  });

  it("never lets an empty translated body erase the original article", () => {
    const r = resolveFeedItemContent({
      ...ORIGINAL,
      translatedTitle: "Заглавие",
      translatedContent: "",
      translationStatus: "completed",
    });
    assert.deepEqual(r, {
      title: "Заглавие",
      content: "Original content",
      usedTranslation: true,
    });
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
      repairs: [],
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
      // still works, and it flags that it had to be used, and how.
      usedRepair: true,
      repairs: ["closed_object"],
    });
  });

  it("rejects a reply cut off mid-string when only a fragment survives", () => {
    // The content value itself is truncated. Closing the string always "works", so length is
    // what decides: two words are a fragment, not a translation, and storing them as a
    // completed translation would be worse than regenerating.
    assert.throws(
      () =>
        parseTranslationResponse('{"title":"Заглавие","content":"Частичен превод, който бе отря'),
      (err: unknown) => err instanceof TranslationParseError && err.reason === "invalid_json"
    );
  });

  it("salvages a cut after a trailing comma, keeping both completed values", () => {
    // The comma promised a THIRD member the schema does not even allow; both values before it
    // are whole. Dropping an unfulfilled promise invents nothing, so the reply is kept rather
    // than thrown away — previously this failed as invalid_json and cost the item a retry.
    const r = parseTranslationResponse('{"title":"Заглавие","content":"Съдържание",');
    assert.equal(r.translatedTitle, "Заглавие");
    assert.equal(r.translatedContent, "Съдържание");
    assert.ok(r.repairs.includes("dropped_partial_member"));
    assert.ok(r.repairs.includes("closed_object"));
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
    assert.throws(
      () => parseTranslationResponse("not json at all"),
      (e: unknown) => {
        assert.ok(e instanceof TranslationParseError);
        assert.equal(e.reason, "invalid_json");
        return true;
      }
    );
  });

  it("rejects Serbian/Macedonian-looking output for a Bulgarian target", () => {
    // Macedonian uses "ј" (and Serbian "ђ/ћ/џ"); none exist in the Bulgarian alphabet. A
    // translation genuinely written in one of them carries them at percent-level density,
    // which is what the guard measures.
    const macedonian = JSON.stringify({
      title: "Компанијата објави нова услуга",
      content:
        "Компанијата денес објави дека новата услуга ќе биде достапна за сите корисници. " +
        "Јас мислам дека ова е добра вест за малите бизниси во земјата, бидејќи цената " +
        "останува иста. Услугата ќе се користи преку мобилната апликација.",
    });
    assert.throws(
      () => parseTranslationResponse(macedonian, "bg"),
      (e: unknown) => {
        assert.ok(e instanceof TranslationParseError);
        assert.equal(e.reason, "wrong_language");
        return true;
      }
    );

    const serbian = '{"title":"Наслов","content":"Ђорђе је отишао кући."}';
    assert.throws(
      () => parseTranslationResponse(serbian, "bg"),
      (e: unknown) => e instanceof TranslationParseError && e.reason === "wrong_language"
    );
  });

  it("rejects an untranslated (Latin-script) reply for a Bulgarian target", () => {
    // The old letter-based guard could not see this at all: an English reply carries no
    // non-Bulgarian Cyrillic, so it passed as a "Bulgarian" translation.
    const english = JSON.stringify({
      title: "Company launches new service",
      content:
        "The company announced today that its new service will be available to all customers " +
        "from next month, and that the price will remain unchanged for existing subscribers.",
    });
    assert.throws(
      () => parseTranslationResponse(english, "bg"),
      (e: unknown) => e instanceof TranslationParseError && e.reason === "wrong_language"
    );
  });

  it("accepts Bulgarian carrying one isolated foreign Cyrillic letter", () => {
    // The production failure this fixes: a fully Bulgarian article with a single copied "ј"
    // in a place name was rejected outright, then regenerated twice, then failed.
    const raw = JSON.stringify({
      title: "Нова услуга за малкия бизнес",
      content:
        "Компанията обяви, че услугата ще бъде достъпна и в Скопје от следващия месец. " +
        "Цената остава непроменена за съществуващите клиенти, а поддръжката се разширява.",
    });
    const r = parseTranslationResponse(raw, "bg");
    assert.match(r.translatedContent!, /Скопје/, "the translation is kept exactly as returned");
    assert.equal(r.language?.verdict, "bulgarian");
    assert.equal(r.language?.foreignCyrillic, 1, "the letter is still counted, just not fatal");
  });

  it("accepts Bulgarian quoting a foreign name repeatedly, while the ratio stays low", () => {
    const raw = JSON.stringify({
      title: "Партньорство",
      content:
        "Компанията подписа договор с фирма от Скопје. Екипът в Скопје ще отговаря за " +
        "поддръжката, а офисът в Скопје се разширява с още десет служители през есента. " +
        "Инвестицията остава непроменена спрямо обявената в началото на годината сума.",
    });
    assert.equal(parseTranslationResponse(raw, "bg").language?.verdict, "bulgarian");
  });

  it("accepts clean Bulgarian (including native ъ/я/ю) for a Bulgarian target", () => {
    const bg =
      '{"title":"Заглавие","content":"Това е текст на български език — ъгъл, ютия, ябълка."}';
    const r = parseTranslationResponse(bg, "bg");
    assert.equal(r.translatedContent, "Това е текст на български език — ъгъл, ютия, ябълка.");
  });

  it("does not language-check when no target language is supplied", () => {
    // The wrong-language guard only runs for Bulgarian targets; without a target it is a no-op.
    const macedonian = '{"title":"Наслов","content":"Ова е на македонски јазик."}';
    assert.equal(
      parseTranslationResponse(macedonian).translatedContent,
      "Ова е на македонски јазик."
    );
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

describe("detectRepetition", () => {
  it("flags the observed 'със със със …' single-word decoding loop", () => {
    const found = detectRepetition(`Новината е важна ${"със ".repeat(30)}край`);
    assert.equal(found?.kind, "repeated_word");
    assert.equal(found?.sample, "със");
    assert.ok(found!.count >= 30);
  });

  it("flags a repeated multi-word phrase cycle", () => {
    const found = detectRepetition(`Текст ${"на държавата ".repeat(8)}край`);
    assert.equal(found?.kind, "repeated_phrase");
    assert.equal(found?.sample, "на държавата");
  });

  it("flags a runaway single-character run", () => {
    const found = detectRepetition(`Заглавие ${"а".repeat(60)}`);
    assert.equal(found?.kind, "repeated_char");
    assert.equal(found?.sample, "а");
  });

  it("ignores punctuation when comparing tokens, so 'със, със, със' still counts", () => {
    const found = detectRepetition("край със, със, със, със, със, със край");
    assert.equal(found?.kind, "repeated_word");
  });

  it("accepts healthy Bulgarian prose (no false positives)", () => {
    const clean =
      "Компанията обяви нова услуга за малкия бизнес в България. " +
      "Тя ще бъде достъпна от следващия месец във всички големи градове, " +
      "а цената остава непроменена за съществуващите клиенти.";
    assert.equal(detectRepetition(clean), null);
  });

  it("allows the natural repetition real text does contain", () => {
    // Ordinary emphasis and a common word recurring — well under the loop thresholds.
    assert.equal(detectRepetition("Много, много добре. Той каза, че това е така."), null);
    assert.equal(detectRepetition("да да да"), null, "three in a row is emphasis, not a loop");
    assert.equal(detectRepetition("Цената е 1000 лв. — виж на www.example.com …"), null);
  });

  it("returns null for short or empty text", () => {
    assert.equal(detectRepetition(""), null);
    assert.equal(detectRepetition("Кратко заглавие"), null);
  });
});

describe("parseTranslationResponse — repetition guard", () => {
  it("rejects a well-formed, right-language reply whose body is a loop", () => {
    const raw = JSON.stringify({ title: "Заглавие", content: "със ".repeat(40) });
    assert.throws(
      () => parseTranslationResponse(raw, "bg"),
      (err: unknown) => err instanceof TranslationParseError && err.reason === "repetition"
    );
  });

  it("carries the finding on the error so the loop is diagnosable from logs", () => {
    const raw = JSON.stringify({ title: "Заглавие", content: "със ".repeat(40) });
    try {
      parseTranslationResponse(raw, "bg");
      assert.fail("expected a repetition rejection");
    } catch (err) {
      assert.ok(err instanceof TranslationParseError);
      assert.equal(err.repetition?.kind, "repeated_word");
      assert.equal(err.repetition?.sample, "със");
    }
  });

  it("still accepts a clean translation (the guard adds no false rejections)", () => {
    const raw = JSON.stringify({ title: "Заглавие", content: "Съвсем нормален текст за теста." });
    const out = parseTranslationResponse(raw, "bg");
    assert.equal(out.translatedContent, "Съвсем нормален текст за теста.");
  });
});

describe("samplingForTry", () => {
  it("starts deterministic, then varies so a regeneration is not a rerun", () => {
    const first = samplingForTry(0);
    assert.equal(first.temperature, 0, "the first try must be deterministic for fidelity");

    const temps = [0, 1, 2].map((i) => samplingForTry(i).temperature);
    assert.equal(new Set(temps).size, 3, "each try must sample differently");
    assert.ok(
      temps.every((t, i) => i === 0 || t > temps[i - 1]),
      "temperature must climb across retries"
    );
  });

  it("raises the repeat penalty across retries to break decoding loops", () => {
    const penalties = [0, 1, 2].map((i) => samplingForTry(i).repeatPenalty);
    assert.equal(penalties[0], 1.1, "the first try uses Ollama's default — no behaviour change");
    assert.ok(penalties.every((p, i) => i === 0 || p > penalties[i - 1]));
    assert.ok(
      penalties.every((p) => p <= 1.5),
      "an excessive penalty degrades the translation"
    );
  });

  it("clamps out-of-range indexes instead of returning undefined", () => {
    assert.deepEqual(samplingForTry(99), samplingForTry(2));
    assert.deepEqual(samplingForTry(-1), samplingForTry(0));
  });
});

describe("retry + timeout budgets", () => {
  it("allows exactly two regenerations on top of the first call", () => {
    assert.equal(MAX_TRANSLATION_RETRIES, 2);
  });

  it("keeps the per-attempt budget under the transport cap so it actually bites", () => {
    // TEXT_WORKER_TIMEOUT_MS is 300_000; a per-attempt bound at or above it would never fire.
    assert.ok(TRANSLATION_ATTEMPT_TIMEOUT_MS < 300_000);
    assert.ok(TRANSLATION_ATTEMPT_TIMEOUT_MS > 0);
  });

  it("bounds the whole item, leaving room for more than one try", () => {
    assert.ok(TRANSLATION_ITEM_TIMEOUT_MS > TRANSLATION_ATTEMPT_TIMEOUT_MS);
    // A single hung article must not be able to consume a whole cron run on its own.
    assert.ok(TRANSLATION_ITEM_TIMEOUT_MS < (MAX_TRANSLATION_RETRIES + 1) * 300_000);
  });
});

describe("isRetriableParseFailure", () => {
  it("treats every model-output defect as worth one more sample", () => {
    for (const reason of [
      "invalid_json",
      "schema_validation",
      "empty_translation",
      "wrong_language",
      "repetition",
    ] as const) {
      assert.equal(isRetriableParseFailure(reason), true, reason);
    }
  });
});

// ─── classifyTranslationInput ─────────────────────────────────────────────────

describe("classifyTranslationInput", () => {
  it("calls an item with an article body 'full'", () => {
    assert.equal(classifyTranslationInput("Title", "Body"), "full");
    assert.equal(classifyTranslationInput(null, "Body"), "full");
  });

  it("calls a body-less item with a title 'title_only'", () => {
    assert.equal(classifyTranslationInput("Title", null), "title_only");
    assert.equal(classifyTranslationInput("Title", ""), "title_only");
    // Whitespace-only is empty: extraction returning "\n \t" is a failed extraction.
    assert.equal(classifyTranslationInput("Title", "  \n\t "), "title_only");
  });

  it("calls an item with neither 'empty'", () => {
    assert.equal(classifyTranslationInput(null, null), "empty");
    assert.equal(classifyTranslationInput("", ""), "empty");
    assert.equal(classifyTranslationInput("   ", "\n"), "empty");
  });
});

// ─── Title-only translation ───────────────────────────────────────────────────

describe("buildTranslationPrompts — title-only mode", () => {
  it("asks for a title-only reply and forbids writing an article body", () => {
    const p = buildTranslationPrompts("Company launches new service", null, "bg");

    assert.equal(p.mode, "title_only");
    assert.match(p.systemPrompt, /Translate the article title into Bulgarian/);
    assert.match(p.systemPrompt, /\{"title": "\.\.\."\}/);
    assert.match(p.systemPrompt, /do not write, summarise, expand, or invent an article body/i);
    // The body key must not even be mentioned as something to fill.
    assert.ok(!p.systemPrompt.includes('"content"'));
    assert.equal(p.userPrompt, "Title: Company launches new service");
    assert.ok(!p.userPrompt.includes("Content:"), "there is no body to send");
  });

  it("constrains structured output to a title-only schema", () => {
    // The schema is the enforcement: a {title, content} schema would REQUIRE the model to
    // emit a content string, which it can only do by inventing one.
    assert.deepEqual(
      buildTranslationPrompts("T", null, "bg").schema,
      TRANSLATION_TITLE_JSON_SCHEMA
    );
    assert.deepEqual(TRANSLATION_TITLE_JSON_SCHEMA, {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
      additionalProperties: false,
    });
  });

  it("keeps the full contract whenever there IS a body", () => {
    const p = buildTranslationPrompts("T", "C", "bg");
    assert.equal(p.mode, "full");
    assert.deepEqual(p.schema, TRANSLATION_JSON_SCHEMA);
  });

  it("keeps the Bulgarian guardrails in title-only mode", () => {
    assert.match(buildTranslationPrompts("T", null, "bg").systemPrompt, /Bulgarian Cyrillic/);
  });
});

describe("parseTranslationResponse — title-only mode", () => {
  const opts = { mode: "title_only" } as const;

  it("stores the translated title and NO content", () => {
    const r = parseTranslationResponse('{"title":"Заглавие"}', "bg", opts);
    assert.equal(r.translatedTitle, "Заглавие");
    assert.equal(r.translatedContent, null, "a body-less article must not gain a body");
  });

  it("discards a body the model invented anyway", () => {
    // The whole point: whatever it wrote there was not translated from anything.
    const raw = '{"title":"Заглавие","content":"Съчинена статия, която никой не е писал."}';
    assert.equal(parseTranslationResponse(raw, "bg", opts).translatedContent, null);
  });

  it("rejects a reply with no usable title", () => {
    for (const raw of ['{"title":""}', '{"title":"   "}', '{"title":null}']) {
      assert.throws(
        () => parseTranslationResponse(raw, "bg", opts),
        (e: unknown) => e instanceof TranslationParseError && e.reason === "empty_translation",
        raw
      );
    }
  });

  it("still rejects a non-Bulgarian title", () => {
    const raw = JSON.stringify({ title: "Ѓорѓи ја објави новата апликација за сите корисници" });
    assert.throws(
      () => parseTranslationResponse(raw, "bg", opts),
      (e: unknown) => e instanceof TranslationParseError && e.reason === "wrong_language"
    );
  });

  it("rejects a title cut off mid-string rather than storing the fragment", () => {
    assert.throws(
      () => parseTranslationResponse('{"title":"Компанията обяви нова', "bg", opts),
      (e: unknown) => e instanceof TranslationParseError && e.reason === "invalid_json"
    );
  });
});

// ─── JSON salvage ─────────────────────────────────────────────────────────────

describe("parseTranslationResponse — JSON salvage", () => {
  it("strips a reasoning model's <think> block", () => {
    const raw =
      '<think>The user wants Bulgarian. Let me translate carefully.</think>\n{"title":"Заглавие","content":"Съдържание"}';
    const r = parseTranslationResponse(raw);
    assert.equal(r.translatedContent, "Съдържание");
    assert.ok(r.repairs.includes("stripped_reasoning"));
  });

  it("rejects a reply that is nothing but an unclosed <think> block", () => {
    // The reasoning ran to the generation limit and the answer never came. There is no
    // translation in there to salvage.
    assert.throws(
      () => parseTranslationResponse("<think>Let me think about how to phrase this"),
      (e: unknown) => e instanceof TranslationParseError && e.reason === "invalid_json"
    );
  });

  it("takes the FIRST complete object, ignoring trailing commentary with braces in it", () => {
    const raw =
      '{"title":"Заглавие","content":"Съдържание"}\nNote: the shape was {title, content}.';
    const r = parseTranslationResponse(raw);
    assert.equal(r.translatedContent, "Съдържание");
    assert.ok(r.repairs.includes("trimmed_prose"));
  });

  it("salvages an unclosed code fence", () => {
    const raw = '```json\n{"title":"Заглавие","content":"Съдържание"}';
    const r = parseTranslationResponse(raw);
    assert.equal(r.translatedContent, "Съдържание");
    assert.ok(r.repairs.includes("stripped_fence"));
  });

  it("escapes raw newlines the model left inside a string value", () => {
    // Legal prose, illegal JSON — and a whole-item failure before this.
    const raw = '{"title":"Заглавие","content":"Първи ред\nВтори ред"}';
    const r = parseTranslationResponse(raw);
    assert.equal(r.translatedContent, "Първи ред\nВтори ред");
    assert.ok(r.repairs.includes("escaped_control_chars"));
  });

  it("salvages a long translation cut off mid-sentence, marking it as an excerpt", () => {
    const body = "Компанията обяви новата услуга за малкия бизнес в страната. ".repeat(6);
    const r = parseTranslationResponse(`{"title":"Заглавие","content":"${body}недовърш`, "bg");

    assert.ok(r.repairs.includes("closed_string"));
    assert.ok(r.repairs.includes("closed_object"));
    assert.ok(r.translatedContent!.length > MIN_REPAIRED_CONTENT_CHARS);
    assert.match(r.translatedContent!, /\[…\]$/, "the cut is marked, not hidden");
    assert.ok(!r.translatedContent!.includes("недовърш"), "the half-written word is dropped");
    assert.equal(r.usedRepair, true);
  });

  it("does not accept a corrupted reply as a translation", () => {
    // Salvage never invents structure: prose with no object at all, a half-written KEY (which
    // must be dropped, not closed into a member the model never wrote), and a value the model
    // barely started all still fail. What salvage may do is keep values that are COMPLETE —
    // see the trailing-comma case above.
    for (const raw of [
      "I'm afraid I can't do that.",
      '{"title":"x","con',
      '{"title":"x","content":',
    ]) {
      assert.throws(() => parseTranslationResponse(raw), TranslationParseError, raw);
    }
  });
});

// ─── assessBulgarian ──────────────────────────────────────────────────────────

describe("assessBulgarian", () => {
  const BG =
    "Компанията обяви нова услуга за малкия бизнес в България. Тя ще бъде достъпна от " +
    "следващия месец във всички големи градове, а цената остава непроменена.";

  it("passes clean Bulgarian, including its native ъ/ь/ю/я", () => {
    assert.equal(assessBulgarian(`${BG} Ъгъл, ютия, ябълка, Пловдьв.`).verdict, "bulgarian");
  });

  it("passes Bulgarian carrying one borrowed word, however often it repeats", () => {
    // One distinct foreign-bearing word is a name, not a language.
    const a = assessBulgarian(`${BG} Офисът в Скопје, екипът в Скопје и складът в Скопје.`);
    assert.equal(a.verdict, "bulgarian");
    assert.equal(a.foreignWords, 1);
    assert.equal(a.foreignCyrillic, 3, "the letters are counted — they are just not fatal");
  });

  it("catches a language by how WIDELY its letters are spread through the vocabulary", () => {
    const macedonian =
      "Компанијата денес објави дека новата услуга ќе биде достапна за сите корисници " +
      "во земјата, бидејќи цената останува иста за постојните претплатници.";
    const a = assessBulgarian(macedonian);
    assert.equal(a.verdict, "foreign_cyrillic");
    assert.ok(a.foreignWords >= 4, `expected many foreign-bearing words, got ${a.foreignWords}`);
  });

  it("catches Russian, whose ы and э are spread the same way", () => {
    const russian =
      "Компания объявила, что новые тарифы вступят в силу с первого числа. Мы считаем, " +
      "что эти изменения были необходимы, а старые условия сохранятся для клиентов.";
    assert.equal(assessBulgarian(russian).verdict, "foreign_cyrillic");
  });

  it("catches a short reply by density, where there is no vocabulary to count", () => {
    assert.equal(assessBulgarian("Ђорђе је отишао кући.").verdict, "foreign_cyrillic");
  });

  it("catches a whole foreign alphabet however short the sample", () => {
    // Three DIFFERENT foreign letters is not a borrowing under any reading.
    assert.equal(assessBulgarian("Њега љуби џак").verdict, "foreign_cyrillic");
  });

  it("catches an untranslated Latin-script reply", () => {
    const a = assessBulgarian(
      "The company announced today that the new service will be available next month."
    );
    assert.equal(a.verdict, "not_cyrillic");
    assert.equal(a.cyrillicLetters, 0);
  });

  it("does not call a short Bulgarian headline untranslated", () => {
    // Below MIN_LETTERS_FOR_SCRIPT_CHECK the script share is noise — a title naming an
    // English product is still a Bulgarian title.
    assert.equal(assessBulgarian("Нов RTX 5090 GPU").verdict, "bulgarian");
  });

  it("does not condemn Bulgarian that is thick with Latin brand names", () => {
    const techy =
      "NVIDIA GeForce RTX 5090 Founders Edition вече се предлага в България на цена, " +
      "която производителят обяви миналата седмица за пазара в Европа.";
    assert.equal(assessBulgarian(techy).verdict, "bulgarian");
  });
});

// ─── Retry feedback ───────────────────────────────────────────────────────────

describe("buildTranslationRetryPrompt", () => {
  it("repeats the original request and names the defect", () => {
    const prompt = buildTranslationRetryPrompt("Title: T\nContent: C", {
      reason: "wrong_language",
      feedback: "Your translation was not Bulgarian.",
    });

    // The evidence must travel with the correction — a model asked to fix an answer it can
    // no longer see edits from memory.
    assert.match(prompt, /Title: T\nContent: C/);
    assert.match(prompt, /YOUR PREVIOUS ANSWER WAS REJECTED/);
    assert.match(prompt, /was not Bulgarian/);
  });

  it("gives every failure reason its own specific correction", () => {
    const feedback = (
      [
        "invalid_json",
        "schema_validation",
        "empty_translation",
        "wrong_language",
        "repetition",
      ] as const
    ).map((reason) => new TranslationParseError("x", reason).feedback);

    assert.equal(new Set(feedback).size, feedback.length, "a generic retry teaches nothing");
    assert.match(feedback[0], /JSON/i);
    assert.match(feedback[3], /Bulgarian/i);
    assert.match(feedback[4], /repeated/i);
  });
});

describe("MIN_TRANSLATION_ITEM_BUDGET_MS", () => {
  it("is a real floor, well under one item's own cap", () => {
    assert.ok(MIN_TRANSLATION_ITEM_BUDGET_MS > 0);
    assert.ok(MIN_TRANSLATION_ITEM_BUDGET_MS < TRANSLATION_ITEM_TIMEOUT_MS);
  });
});

// ─── Translation-input sanitising ─────────────────────────────────────────────

/**
 * The real Readability output of the ArchDaily article in the production logs, reproduced
 * verbatim: a video-player timestamp, a subscriber label glued to the caption, a CC photo
 * credit running straight into the publication date, the article itself, then the trailer —
 * gallery navigation, the cite block (which carries a raw `"` and a bare `<URL>`), the ISSN,
 * the Chinese language-switcher string, and a newsletter modal.
 */
const ARCHDAILY_EXTRACT = [
  "5:40",
  "",
  "    5:40",
  "",
  "Subscriber AccessSardar Patel Stadium (Navrangpura Stadium), Ahmedabad. Image © Carlo " +
    "Fumarola via Wikipedia under license CC BY-SA 3.0Published on August 17, 2026In the heart " +
    "of Ahmedabad's Navrangpura district in India sits the Sardar Vallabhbhai Patel Stadium. " +
    "More than just a cricket ground, the stadium stands as one of India's earliest experiments " +
    "in modernist public architecture. Built in the decades following the country's " +
    "independence, the structure has not only become an engineering landmark, but also a major " +
    "public space within Ahmedabad's urban fabric. + 2",
  "To understand this project better, it helps to look at India during the early years after " +
    "independence in 1947. Under Prime Minister Jawaharlal Nehru, the nation set out to " +
    "modernize rapidly by industrializing its cities and founding new academic and civic " +
    "institutions, most famously the city of Chandigarh.",
  "",
  "",
  "Image gallerySee allShow lessAbout this authorAuthor",
  'Cite: Moises Carrasco.  "Modernism on the Watch: Preserving the Sardar Vallabhbhai Patel ' +
    'Stadium in India"  17 Aug 2026. ArchDaily.  Accessed . ' +
    "<https://www.archdaily.com/1183078/modernism-on-the-watch> ISSN 0719-8884" +
    "想阅读文章的中文版本吗?守望现代主义：印度萨达尔·瓦拉巴伊·帕特尔体育场的保护是否",
  "",
  "Did you know?You'll now receive updates based on what you follow! Personalize your stream " +
    "and start following your favorite authors, offices and users.",
].join("\n");

describe("sanitiseTranslationContent — ArchDaily", () => {
  const clean = sanitiseTranslationContent(ARCHDAILY_EXTRACT)!;

  it("removes the trailer: gallery navigation, the cite block and the newsletter modal", () => {
    assert.ok(!clean.includes("Image gallery"));
    assert.ok(!clean.includes("About this author"));
    assert.ok(!clean.includes("Cite:"));
    assert.ok(!clean.includes("ISSN"));
    assert.ok(!clean.includes("Did you know"));
  });

  it("removes the Chinese language-switcher text that produced the Chinese replies", () => {
    // This is the ORIGIN of the "Chinese instead of Bulgarian" failures: the model was
    // echoing its own input. No CJK survives sanitising.
    assert.ok(
      !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(clean),
      `expected no CJK, got: ${clean.slice(-160)}`
    );
  });

  it("removes the cite block's raw quote and bare URL — the invalid_json characters", () => {
    assert.ok(!clean.includes('"Modernism on the Watch'));
    assert.ok(!clean.includes("<https://"));
  });

  it("removes inline boilerplate even when it is glued to the next word", () => {
    // Readability emits "Subscriber AccessSardar" and "CC BY-SA 3.0Published on …", so neither
    // label has a word boundary in front of it — the reason both patterns are boundary-free.
    assert.ok(!clean.includes("Subscriber Access"));
    assert.ok(!clean.includes("Published on August"));
    assert.ok(!clean.includes("under license"));
    assert.ok(!/\b5:40\b/.test(clean), "the video-player timestamp is not article text");
    assert.ok(!/\+ 2\b/.test(clean), "the gallery counter is not article text");
  });

  it("keeps the article itself intact", () => {
    assert.ok(clean.includes("In the heart of Ahmedabad's Navrangpura district"));
    assert.ok(clean.includes("earliest experiments in modernist public architecture"));
    assert.ok(clean.includes("most famously the city of Chandigarh."));
  });

  it("cuts the body substantially — noise was roughly a third of the page", () => {
    assert.ok(
      clean.length < ARCHDAILY_EXTRACT.length * 0.8,
      `expected a real reduction, got ${ARCHDAILY_EXTRACT.length} → ${clean.length}`
    );
    // …but not so much that the article is gone.
    assert.ok(clean.length > 700, `expected the article to survive, got ${clean.length}`);
  });
});

describe("sanitiseTranslationContent — guards", () => {
  const ARTICLE =
    "The company announced a new service for small businesses across the country today. " +
    "It will be available from next month in every major city, and the price is unchanged. " +
    "Analysts expect the rollout to take about six weeks from the first announcement. ";

  it("passes null through", () => {
    assert.equal(sanitiseTranslationContent(null), null);
  });

  it("ignores a trailer marker that would take most of the article", () => {
    // A marker near the very top is far likelier to be a false positive than a real trailer,
    // so the cut is abandoned rather than reducing the article to a sentence.
    const body = `Did you know? ${ARTICLE.repeat(3)}`;
    const clean = sanitiseTranslationContent(body)!;
    assert.ok(clean.includes("Analysts expect the rollout"), "the article must survive");
    assert.ok(clean.length > body.length * 0.8);
  });

  it("leaves a genuinely Chinese article alone", () => {
    // Above the incidental-CJK density this is an East-Asian source, not an English page
    // carrying a switcher string. Gutting its CJK would delete the article.
    const chinese = "这是一篇关于建筑保护的文章。".repeat(20);
    assert.equal(sanitiseTranslationContent(chinese), chinese);
  });

  it("returns the original when the passes would leave too little to translate", () => {
    const mostlyTrailer = "Cite: Someone. ArchDaily. Accessed . ISSN 0719-8884";
    assert.equal(sanitiseTranslationContent(mostlyTrailer), mostlyTrailer);
  });

  it("strips HTML markup, which a feed <description> routinely carries", () => {
    const html = `<p>${ARTICLE}</p><a href="https://x.example/tag">tag</a>`;
    const clean = sanitiseTranslationContent(html)!;
    assert.ok(!clean.includes("<p>"));
    assert.ok(!clean.includes("href"));
    assert.ok(clean.includes("The company announced a new service"));
  });

  it("collapses control characters and runaway whitespace", () => {
    // Control characters are built rather than typed so this source file stays plain ASCII.
    const ctrl = String.fromCharCode(0, 7, 31);
    const messy = `${ARTICLE} ${ctrl}\n\n\n\n\n${ARTICLE}\t\t\tend of it.`;
    const clean = sanitiseTranslationContent(messy)!;

    const hasControl = [...clean].some((c) => {
      const code = c.codePointAt(0)!;
      return (code < 0x20 && c !== "\n") || code === 0x7f;
    });
    assert.ok(!hasControl, "raw control characters are illegal inside a JSON string");
    assert.ok(!/\n{3,}/.test(clean), "runs of blank lines are collapsed");
    assert.ok(!/ {2,}/.test(clean), "runs of spaces are collapsed");
    assert.ok(clean.includes("end of it."), "the text itself survives");
  });

  it("leaves ordinary prose untouched", () => {
    const clean = sanitiseTranslationContent(ARTICLE.repeat(2))!;
    assert.ok(clean.startsWith("The company announced"));
    assert.ok(clean.includes("Analysts expect the rollout"));
  });
});

// ─── Shrinking retry budget ───────────────────────────────────────────────────

describe("shrinkTranslationContentBudget", () => {
  it("halves the budget so a retry is a materially smaller request", () => {
    assert.equal(shrinkTranslationContentBudget(MAX_TRANSLATION_CONTENT_CHARS), 1500);
    assert.equal(shrinkTranslationContentBudget(1500), 800);
  });

  it("never shrinks below the floor — a smaller excerpt is not an article", () => {
    assert.equal(
      shrinkTranslationContentBudget(MIN_TRANSLATION_CONTENT_CHARS),
      MIN_TRANSLATION_CONTENT_CHARS
    );
    assert.equal(shrinkTranslationContentBudget(10), MIN_TRANSLATION_CONTENT_CHARS);
  });
});

// ─── Derived Bulgarian title for (untitled) articles ──────────────────────────

describe("buildTranslationPrompts — untitled article with a body", () => {
  const BODY =
    "In the heart of Ahmedabad's Navrangpura district in India sits the Sardar Vallabhbhai " +
    "Patel Stadium, one of the country's earliest experiments in modernist public architecture. " +
    "The World Monuments Fund placed it on its Watch list in 2020. ".repeat(3);

  it("asks the model to write a Bulgarian title instead of accepting an empty one", () => {
    const p = buildTranslationPrompts(null, BODY, "bg");
    assert.equal(p.mode, "full", "there is a body, so this is not a title-only item");
    assert.equal(p.derivedTitle, true);
    assert.match(p.systemPrompt, /has no title of its own/);
    assert.match(p.systemPrompt, /Write a short Bulgarian title/);
    assert.ok(
      !p.systemPrompt.includes('use an empty string "" for "title"'),
      "the instruction that produced null titles must be gone for this case"
    );
  });

  it("forbids inventing anything the body does not already say", () => {
    const p = buildTranslationPrompts(null, BODY, "bg");
    assert.match(p.systemPrompt, /invent nothing/);
    assert.match(p.systemPrompt, /at most 90 characters/);
  });

  it("leaves an article that HAS a title exactly as before", () => {
    const p = buildTranslationPrompts("A real headline", BODY, "bg");
    assert.equal(p.derivedTitle, false);
    assert.match(p.systemPrompt, /use an empty string "" for "title"/);
    assert.ok(!p.systemPrompt.includes("has no title of its own"));
  });

  it("still treats a bodyless untitled item as title-only, not as a derivation", () => {
    const p = buildTranslationPrompts("Only a headline", null, "bg");
    assert.equal(p.mode, "title_only");
    assert.equal(p.derivedTitle, false);
  });
});

describe("buildTranslationPrompts — sanitising and the content budget", () => {
  it("sends the sanitised body, not the raw page", () => {
    const p = buildTranslationPrompts("T", ARCHDAILY_EXTRACT, "bg");
    assert.ok(!p.userPrompt.includes("Cite:"));
    assert.ok(!p.userPrompt.includes("Did you know"));
    assert.ok(p.userPrompt.includes("In the heart of Ahmedabad's Navrangpura district"));
    assert.ok(p.contentChars < ARCHDAILY_EXTRACT.length);
  });

  it("honours a smaller maxContentChars, which is what a truncation retry passes", () => {
    const long = "Дълга статия за нещо важно и интересно. ".repeat(200);
    const full = buildTranslationPrompts("T", long, "bg");
    const small = buildTranslationPrompts("T", long, "bg", { maxContentChars: 900 });
    // The cap backs up to the last word boundary before appending " […]", so the exact length
    // lands just under the ceiling rather than on it.
    assert.ok(full.contentChars <= MAX_TRANSLATION_CONTENT_CHARS + 4);
    assert.ok(full.contentChars > MAX_TRANSLATION_CONTENT_CHARS - 50);
    assert.ok(small.contentChars < full.contentChars);
    assert.ok(small.contentChars <= 904);
    assert.ok(small.userPrompt.length < full.userPrompt.length);
  });

  it("tells the model not to copy foreign-script words through", () => {
    const p = buildTranslationPrompts("T", "Some article body here.", "bg");
    assert.match(p.systemPrompt, /Chinese, Japanese, Korean/);
  });

  it("names the JSON escaping rule the malformed replies broke", () => {
    const p = buildTranslationPrompts("T", "Some article body here.", "bg");
    assert.match(p.systemPrompt, /escape every double quote/);
    assert.match(p.systemPrompt, /Never put a raw newline or an unescaped quote/);
  });
});

// ─── Truncation-shaped salvage + the truncated flag ───────────────────────────

/** The reason and truncated flag a rejected reply carries, or null when it was accepted. */
function rejection(
  raw: string,
  targetLang?: string,
  mode?: "full" | "title_only"
): { reason: string; truncated: boolean } | null {
  try {
    parseTranslationResponse(raw, targetLang, mode ? { mode } : {});
    return null;
  } catch (err) {
    assert.ok(err instanceof TranslationParseError, `expected a parse error for ${raw}`);
    return { reason: err.reason, truncated: err.truncated };
  }
}

describe("parseTranslationResponse — truncation shapes", () => {
  const BG_BODY = "Компанията обяви новата услуга за малкия бизнес в страната. ".repeat(6);

  it("drops a half-written key rather than inventing a member for it", () => {
    // Closing `"cont` as a VALUE would fabricate a member the model never wrote.
    const r = rejection('{"title":"Заглавие","cont');
    assert.deepEqual(r, { reason: "schema_validation", truncated: true });
  });

  it("drops a key whose value never arrived", () => {
    const r = rejection('{"title":"Заглавие","content":');
    assert.deepEqual(r, { reason: "schema_validation", truncated: true });
  });

  it("flags a fragment cut off mid-value as truncated", () => {
    const r = rejection('{"title":"Заглавие","content":"Частичен превод, който бе отря');
    assert.deepEqual(r, { reason: "invalid_json", truncated: true });
  });

  it("flags a title cut off mid-string as truncated, in title-only mode", () => {
    const r = rejection('{"title":"Модернизмът под набл', "bg", "title_only");
    assert.deepEqual(r, { reason: "invalid_json", truncated: true });
  });

  it("does NOT flag a wrong-language reply as truncated — shrinking would not fix it", () => {
    const english =
      '{"title":"Modernism on the Watch","content":"The company announced today that the new ' +
      'service will be available next month across every major city in the country."}';
    const r = rejection(english, "bg");
    assert.deepEqual(r, { reason: "wrong_language", truncated: false });
  });

  it("does NOT flag prose with no JSON at all as truncated", () => {
    const r = rejection("I'm afraid I can't do that.");
    assert.equal(r!.truncated, false);
  });

  it("still salvages a long body cut mid-sentence, and marks it truncated only if rejected", () => {
    // Long enough to clear MIN_REPAIRED_CONTENT_CHARS, so it is ACCEPTED as an excerpt.
    const r = parseTranslationResponse(`{"title":"Заглавие","content":"${BG_BODY}недовърш`, "bg");
    assert.ok(r.translatedContent!.length > MIN_REPAIRED_CONTENT_CHARS);
    assert.ok(r.repairs.includes("closed_string"));
    assert.match(r.translatedContent!, /\[…\]$/);
  });
});

// ─── Language drift the old census could not see ──────────────────────────────

describe("assessBulgarian — non-Latin drift", () => {
  it("rejects an all-Chinese reply that the Latin/Cyrillic-only census let through", () => {
    // Previously this scored totalLetters ≈ 0, fell under MIN_LETTERS_FOR_SCRIPT_CHECK, skipped
    // the script test and was stored as a completed Bulgarian translation.
    const chinese =
      "想阅读文章的中文版本吗守望现代主义印度萨达尔瓦拉巴伊帕特尔体育场的保护是否值得关注这是一个非常重要的问题";
    const a = assessBulgarian(chinese);
    assert.equal(a.verdict, "not_cyrillic");
    assert.equal(a.cyrillicLetters, 0);
    assert.ok(
      a.otherLetters >= 40,
      `expected the Han letters to be counted, got ${a.otherLetters}`
    );
  });

  it("rejects a short untranslated English title that was too short to judge before", () => {
    // A title-only reply is judged on the title alone and almost never reaches
    // MIN_LETTERS_FOR_SCRIPT_CHECK — so an untouched English headline used to pass silently.
    const a = assessBulgarian("Modernism on the Watch");
    assert.equal(a.verdict, "not_cyrillic");
    assert.equal(a.cyrillicLetters, 0);
  });

  it("rejects an untranslated English title through the parser too", () => {
    const r = rejection('{"title":"Modernism on the Watch"}', "bg", "title_only");
    assert.deepEqual(r, { reason: "wrong_language", truncated: false });
  });

  it("still accepts a short Bulgarian title — valid Bulgarian is not collateral", () => {
    assert.equal(assessBulgarian("Модернизмът под наблюдение").verdict, "bulgarian");
    assert.equal(assessBulgarian("Нов RTX 5090 GPU").verdict, "bulgarian");
    assert.equal(assessBulgarian("Пет нови сгради в София").verdict, "bulgarian");
  });

  it("still accepts a full Bulgarian article carrying Latin brand names", () => {
    const bg =
      "Модернизмът под наблюдение: опазването на стадион „Сардар Валабхай Пател“ в Индия. " +
      "World Monuments Fund го включи в списъка си през 2020 година, а сградата остава " +
      "важно обществено пространство в Ахмедабад.";
    const a = assessBulgarian(bg);
    assert.equal(a.verdict, "bulgarian");
    assert.equal(a.otherLetters, 0);
  });

  it("is not fooled by a mostly-Latin reply with a token of Cyrillic", () => {
    const a = assessBulgarian(
      "Модернизъм. The company announced today that the new service will be available next " +
        "month across every major city, and the price remains unchanged for existing customers."
    );
    assert.equal(a.verdict, "not_cyrillic");
  });
});
