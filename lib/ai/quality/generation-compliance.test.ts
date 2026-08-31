import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateGenerationCompliance, NO_COMPLIANCE_CHECK } from "./generation-compliance";

const check = (text: string) => validateGenerationCompliance({ text });

// ─── Stylistic dimensions are guidance, never a gate ─────────────────────────
// The gate used to verify that a post honoured the CTA / hook / structure /
// angle it was generated under, and a miss cost the post its life
// (retry ×3 → POST_FAILED_COMPLIANCE). These tests pin the reversal: the same
// texts that used to fail must now pass, and the gate must SAY it did not check
// them rather than quietly reporting a pass it never earned.

describe("validateGenerationCompliance — stylistic dimensions are never enforced", () => {
  it("a post with no share invitation passes (the Share CTA is not gated)", () => {
    const result = check("Есента е чудесно време за пътуване из Португалия.");
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.status, "passed");
    assert.deepEqual(result.reasons, []);
    assert.deepEqual(result.failures, []);
  });

  it("a post with no follow/comment/website/reflection CTA passes", () => {
    const result = check("Lisbon in autumn is quieter, cheaper, and still warm enough to swim.");
    assert.strictEqual(result.passed, true);
    assert.deepEqual(result.reasons, []);
  });

  it("a post that is not a list passes (the List structure is not gated)", () => {
    const result = check(
      "Едно дълго изречение без нито един номериран или маркиран елемент в него."
    );
    assert.strictEqual(result.passed, true);
    assert.deepEqual(result.reasons, []);
  });

  it("a post that names no misconception passes (Myth vs Fact is not gated)", () => {
    const result = check("Нашата нова колекция е вече в наличност онлайн и в магазините.");
    assert.strictEqual(result.passed, true);
    assert.deepEqual(result.reasons, []);
  });

  it("a post with no contrast opening passes (the Contrast hook is not gated)", () => {
    const result = check("Автентичната кухня на Лисабон заслужава поне един свободен ден.");
    assert.strictEqual(result.passed, true);
    assert.deepEqual(result.reasons, []);
  });

  it("a post with no actionable tips passes (Tips & Tricks is not gated)", () => {
    const result = check("Пътуването разширява хоризонтите — това е всичко за днес.");
    assert.strictEqual(result.passed, true);
    assert.deepEqual(result.reasons, []);
  });

  it("missing EVERY stylistic requirement at once still passes", () => {
    // No share invitation, no list, no misconception, no contrast, no tips —
    // the exact combination that used to burn all three attempts and discard
    // the post. It is now a clean pass.
    const result = check("Днес отваряме новия си офис в центъра на София.");
    assert.strictEqual(result.status, "passed");
    assert.strictEqual(result.passed, true);
    assert.deepEqual(result.reasons, []);
    assert.deepEqual(result.failures, []);
  });
});

describe("validateGenerationCompliance — unenforced dimensions report as unchecked", () => {
  it("marks angle/hook/structure/cta as NOT checked rather than as passed", () => {
    const result = check("Ordinary post text with nothing stylistic about it.");
    assert.deepEqual(result.checked, {
      angle: false,
      hook: false,
      structure: false,
      cta: false,
      bannedWords: true,
      // No language was declared by this caller, so the language dimension did
      // not run — and says so, rather than reporting a pass it never earned.
      language: false,
    });
  });

  it("reports the same unchecked dimensions on a failing result", () => {
    // A banned word must not make the gate claim it verified anything else.
    const result = check("Стоп на високите цени.");
    assert.strictEqual(result.status, "failed");
    assert.strictEqual(result.checked.cta, false);
    assert.strictEqual(result.checked.hook, false);
    assert.strictEqual(result.checked.angle, false);
    assert.strictEqual(result.checked.structure, false);
    assert.strictEqual(result.checked.bannedWords, true);
  });

  it("only ever attributes a failure to an enforced dimension", () => {
    const result = check("Стоп! Няма списък, няма контраст, няма CTA тук.");
    assert.ok(result.failures.length > 0);
    for (const failure of result.failures) {
      assert.strictEqual(
        failure.dimension,
        "bannedWords",
        "a stylistic dimension must never appear as a compliance failure"
      );
    }
  });
});

// ─── Banned word: "Стоп" ─────────────────────────────────────────────────────
// Product decision: the standalone Bulgarian word "стоп" must never appear in
// generated text — any casing, any punctuation, anywhere, and especially not as
// the opening hook. This is the one thing the gate still enforces.

describe("validateGenerationCompliance — banned word Стоп", () => {
  it("fails on the plain word", () => {
    const result = check("Стоп на скъпите самолетни билети този сезон.");
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.status, "failed");
    assert.ok(result.reasons.some((r) => /Стоп/.test(r)));
  });

  it("fails regardless of casing — СТОП", () => {
    assert.strictEqual(check("СТОП на компромисите с качеството.").passed, false);
  });

  it("fails regardless of casing — mixed", () => {
    assert.strictEqual(check("СтОп с чакането — резервирайте сега.").passed, false);
  });

  it("fails with trailing punctuation — Стоп!", () => {
    assert.strictEqual(check("Стоп! Не изпускайте тази оферта.").passed, false);
  });

  it("fails inside a longer phrase — Стоп на…", () => {
    assert.strictEqual(
      check("Стоп на скучните пътувания — открийте нещо ново с нас.").passed,
      false
    );
  });

  it("fails inside an imperative phrase — Кажи стоп на…", () => {
    assert.strictEqual(check("Кажи стоп на пропуснатите оферти и резервирай днес.").passed, false);
  });

  it("fails when used as the opening hook", () => {
    assert.strictEqual(
      check("Стоп! Това е последният шанс да хванете нашата есенна промоция тази година.").passed,
      false
    );
  });

  it("fails when it appears later in the post, not just the opening", () => {
    assert.strictEqual(
      check("Есента вече е тук. Стоп на високите цени — вижте новите ни оферти още днес.").passed,
      false
    );
  });

  it("reports the violation as a structured bannedWords failure", () => {
    const result = check("Стоп на високите цени.");
    assert.strictEqual(result.failures.length, 1);
    assert.strictEqual(result.failures[0].dimension, "bannedWords");
    assert.ok(/Стоп/.test(result.failures[0].reason));
    assert.deepEqual(
      result.reasons,
      result.failures.map((f) => f.reason),
      "reasons and failures must describe the same violation"
    );
  });

  it("does not flag words that merely contain the letters — автостоп", () => {
    const result = check("Автостоп остава любим начин за евтино пътуване из Европа.");
    assert.strictEqual(result.passed, true);
    assert.deepEqual(result.reasons, []);
  });

  it("does not flag words that merely contain the letters — стопанство", () => {
    assert.strictEqual(check("Селското стопанство в региона расте с всяка година.").passed, true);
  });

  it("does not flag the English word 'stop' — Latin script, not the Cyrillic word", () => {
    assert.strictEqual(check("Don't stop planning your next trip — book it today.").passed, true);
  });

  it("passes ordinary Bulgarian text with no banned word", () => {
    const result = check("Есента носи по-ниски цени на самолетните билети тази година.");
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.checked.bannedWords, true);
  });

  it("fails even when the post is otherwise well written", () => {
    // Nothing about a post's quality or style can buy off a banned term.
    const result = check("Следвайте ни за още съвети. Стоп на скучните пътувания!");
    assert.strictEqual(result.status, "failed");
    assert.strictEqual(result.passed, false);
  });
});

describe("validateGenerationCompliance — result semantics", () => {
  it("a real call always evaluates something, so it is never not_checked", () => {
    const result = check("Any text at all.");
    assert.strictEqual(result.evaluated, true);
    assert.notStrictEqual(result.status, "not_checked");
  });

  it("status passed and failed track the enforced check exactly", () => {
    assert.strictEqual(check("Чисто изречение без забранени думи.").status, "passed");
    assert.strictEqual(check("Стоп на това.").status, "failed");
  });
});

describe("NO_COMPLIANCE_CHECK", () => {
  it("is a neutral, explicitly UNVERIFIED result — never a pass", () => {
    assert.strictEqual(NO_COMPLIANCE_CHECK.status, "not_checked");
    assert.strictEqual(NO_COMPLIANCE_CHECK.evaluated, false);
    // Non-blocking, because "we could not check" must not stop a generation.
    assert.strictEqual(NO_COMPLIANCE_CHECK.passed, true);
    assert.deepEqual(NO_COMPLIANCE_CHECK.reasons, []);
    assert.deepEqual(NO_COMPLIANCE_CHECK.checked, {
      angle: false,
      hook: false,
      cta: false,
      structure: false,
      bannedWords: false,
      language: false,
    });
  });
});
