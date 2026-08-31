import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkLanguageQuality,
  MALFORMED_CONSTRUCTIONS,
  MIN_SCRIPT_SAMPLE_LETTERS,
} from "./language-quality";

const bg = (text: string) => checkLanguageQuality({ text, language: "BG" });

// ─── Known malformed constructions ───────────────────────────────────────────
// A small, extensible list — not a grammar engine. Each entry is a construction
// the model has been observed to emit systematically and that no native speaker
// would write.

describe("checkLanguageQuality — malformed Bulgarian constructions", () => {
  it('rejects the malformed "Има ли ти мислил" opener', () => {
    const result = bg("Има ли ти мислил, че един смесител може да промени цялата баня?");
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.failures[0]?.kind, "malformed_construction");
    assert.ok(result.failures[0]?.reason.length > 0);
  });

  it("rejects it anywhere in the post, not only as the opening", () => {
    const result = bg("Смесителят е сърцето на банята. Има ли ти мислил защо?");
    assert.strictEqual(result.passed, false);
  });

  it("rejects it in any casing and with any spacing", () => {
    for (const text of [
      "ИМА ЛИ ТИ МИСЛИЛ, че смесителят тежи?",
      "има  ли   ти  мислил, че смесителят тежи?",
      "Има ли ви мислили за това?",
    ]) {
      assert.strictEqual(bg(text).passed, false, text);
    }
  });

  it("does NOT reject correct Bulgarian reflection openers", () => {
    // These are grammatical. They may still fail OPENING DIVERSITY when recent
    // history is saturated — that is a different check, with a different remedy.
    for (const text of [
      "Мислил ли си някога колко вода тече напразно?",
      "Замислял ли си се дали смесителят ти пести вода?",
      "Знаеш ли, че керамичният картуш издържа над десет години?",
      "Чувал ли си за смесителите с ограничител на дебита?",
    ]) {
      assert.strictEqual(bg(text).passed, true, text);
    }
  });

  it("does not fire on unrelated Bulgarian text that merely contains the words", () => {
    assert.strictEqual(bg("Има много неща, за които не сме мислили.").passed, true);
    assert.strictEqual(bg("Мислил съм за това дълго.").passed, true);
  });

  it("keeps the construction list open for extension", () => {
    assert.ok(MALFORMED_CONSTRUCTIONS.length >= 1);
    for (const rule of MALFORMED_CONSTRUCTIONS) {
      assert.ok(rule.id.length > 0);
      assert.ok(rule.reason.length > 0);
      assert.strictEqual(rule.language, "BG");
    }
  });

  it("does not run Bulgarian rules against an English post", () => {
    const result = checkLanguageQuality({
      text: "Have you ever thought about how much a tap matters?",
      language: "EN",
    });
    assert.strictEqual(result.passed, true);
  });
});

// ─── English leakage on a Bulgarian channel ──────────────────────────────────

describe("checkLanguageQuality — wrong-script output", () => {
  it("rejects a predominantly English post when Bulgarian is required", () => {
    const result = bg(
      "Ever found yourself fumbling with two separate taps just to get the temperature right? " +
        "A single-lever mixer solves that in one movement, and it uses noticeably less water " +
        "over a year of daily use. Small change, real difference."
    );
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.failures[0]?.kind, "wrong_language");
  });

  it("rejects the second observed leakage sample", () => {
    const result = bg(
      "You've probably heard that modern faucets are all about design. They are not. " +
        "The cartridge inside decides whether it still works in ten years, and that is " +
        "the part nobody shows you in the shop."
    );
    assert.strictEqual(result.passed, false);
  });

  it("accepts Bulgarian text containing product names, model codes and a URL", () => {
    const result = bg(
      "Новата серия Grohe Eurosmart Cosmopolitan вече е в наличност. " +
        "Моделът GRS-2400 CE използва керамичен картуш и ограничител на дебита, " +
        "който намалява разхода на вода без да отнема от комфорта. " +
        "Виж цялата серия на https://example.com/grohe-eurosmart-cosmopolitan #баня #ремонт"
    );
    assert.strictEqual(result.passed, true);
  });

  it("accepts Bulgarian text that is mostly hashtags and a link", () => {
    const result = bg(
      "Смесителят е сърцето на банята. Избери го внимателно. " +
        "https://example.com/a #interiordesign #bathroom #renovation #home #design"
    );
    assert.strictEqual(result.passed, true);
  });

  it("does not judge a sample too short to be evidence", () => {
    const result = bg("New!");
    assert.strictEqual(result.passed, true);
    assert.ok("New!".replace(/[^A-Za-z]/g, "").length < MIN_SCRIPT_SAMPLE_LETTERS);
  });

  it("accepts an English post when English is required", () => {
    const result = checkLanguageQuality({
      text: "A single-lever mixer solves the temperature problem in one movement and wastes less water.",
      language: "EN",
    });
    assert.strictEqual(result.passed, true);
  });

  it("rejects a Bulgarian post when English is required", () => {
    const result = checkLanguageQuality({
      text: "Смесителят е сърцето на банята и заслужава повече внимание, отколкото обикновено получава.",
      language: "EN",
    });
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.failures[0]?.kind, "wrong_language");
  });

  it("does nothing when no language is declared", () => {
    const result = checkLanguageQuality({ text: "Има ли ти мислил, че това е така?" });
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.evaluated, false);
  });
});
