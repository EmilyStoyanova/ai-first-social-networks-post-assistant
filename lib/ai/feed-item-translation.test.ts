import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_TRANSLATION_ATTEMPTS,
  MAX_TRANSLATION_CONTENT_CHARS,
  buildTranslationPrompts,
  capTranslationContent,
  computeTranslationBackoff,
  computeTranslationHash,
  isTranslatableSourceType,
  parseTranslationResponse,
  requiresTranslationWork,
  resolveFeedItemContent,
  resolveTranslationConfig,
  TranslationParseError,
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
  it("parses a plain JSON object", () => {
    const r = parseTranslationResponse('{"title":"Заглавие","content":"Съдържание"}');
    assert.deepEqual(r, { translatedTitle: "Заглавие", translatedContent: "Съдържание" });
  });

  it("tolerates code fences and surrounding prose", () => {
    const raw = 'Sure!\n```json\n{"title":"Заглавие","content":"Съдържание"}\n```';
    const r = parseTranslationResponse(raw);
    assert.equal(r.translatedTitle, "Заглавие");
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
});

// ─── buildTranslationPrompts ──────────────────────────────────────────────────

describe("buildTranslationPrompts", () => {
  it("names the target language and asks for JSON only", () => {
    const { systemPrompt, userPrompt } = buildTranslationPrompts("T", "C", "bg");
    assert.match(systemPrompt, /into bg/);
    assert.match(systemPrompt, /Return JSON/);
    assert.match(userPrompt, /Title: T/);
    assert.match(userPrompt, /Content: C/);
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
