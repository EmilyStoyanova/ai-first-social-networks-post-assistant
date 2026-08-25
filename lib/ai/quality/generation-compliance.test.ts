import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateGenerationCompliance, NO_COMPLIANCE_CHECK } from "./generation-compliance";
import type { PostPattern } from "../post-pattern";

function pattern(overrides: Partial<PostPattern> = {}): PostPattern {
  return { hookType: "Question", structure: "Single Insight", ctaType: "No CTA", ...overrides };
}

// ─── CTA compliance ─────────────────────────────────────────────────────────

describe("validateGenerationCompliance — CTA", () => {
  it("Follow: passes when an explicit follow/connect invitation is present", () => {
    const result = validateGenerationCompliance({
      text: "Here is a useful insight about our product. Follow us for more tips like this!",
      angle: "Educational",
      pattern: pattern({ ctaType: "Follow" }),
    });
    assert.strictEqual(result.passed, true);
    assert.deepEqual(result.reasons, []);
  });

  it("Follow: passes on the Bulgarian imperative следвайте ни", () => {
    const result = validateGenerationCompliance({
      text: "Ето един полезен съвет за пътуване. Следвайте ни за още съвети.",
      angle: "Educational",
      pattern: pattern({ ctaType: "Follow" }),
    });
    assert.strictEqual(result.passed, true);
  });

  it("Follow: fails when there is no follow/connect invitation", () => {
    const result = validateGenerationCompliance({
      text: "Here is a useful insight about our product and why it matters.",
      angle: "Educational",
      pattern: pattern({ ctaType: "Follow" }),
    });
    assert.strictEqual(result.passed, false);
    assert.ok(
      result.reasons.some((r) => r.includes("Follow CTA is required")),
      `expected a Follow CTA reason, got: ${JSON.stringify(result.reasons)}`
    );
  });

  it("Comment Prompt: passes when the post asks for opinions/comments", () => {
    const result = validateGenerationCompliance({
      text: "This is a great insight about our product. What's your take on it? Let us know below.",
      angle: "Educational",
      pattern: pattern({ ctaType: "Comment Prompt" }),
    });
    assert.strictEqual(result.passed, true);
  });

  it("Comment Prompt: fails when nothing invites a comment or opinion", () => {
    const result = validateGenerationCompliance({
      text: "This is a great insight about our product and why it matters to you.",
      angle: "Educational",
      pattern: pattern({ ctaType: "Comment Prompt" }),
    });
    assert.strictEqual(result.passed, false);
    assert.ok(result.reasons.some((r) => r.includes("Comment Prompt CTA is required")));
  });

  it("Share: passes when there is an explicit invitation to share", () => {
    const result = validateGenerationCompliance({
      text: "This tip could help a friend. Share this with someone who needs it today.",
      angle: "Educational",
      pattern: pattern({ ctaType: "Share" }),
    });
    assert.strictEqual(result.passed, true);
  });

  it("Share: fails when there is no share invitation", () => {
    const result = validateGenerationCompliance({
      text: "This tip could help a lot of people who are just getting started.",
      angle: "Educational",
      pattern: pattern({ ctaType: "Share" }),
    });
    assert.strictEqual(result.passed, false);
    assert.ok(result.reasons.some((r) => r.includes("Share CTA is required")));
  });

  it("Website Visit: passes when there is a visit/link prompt", () => {
    const result = validateGenerationCompliance({
      text: "We just published a full breakdown. Visit our website for the full guide.",
      angle: "Educational",
      pattern: pattern({ ctaType: "Website Visit" }),
    });
    assert.strictEqual(result.passed, true);
  });

  it("Website Visit: fails when there is no visit/link prompt", () => {
    const result = validateGenerationCompliance({
      text: "We just published a full breakdown of everything you need to know.",
      angle: "Educational",
      pattern: pattern({ ctaType: "Website Visit" }),
    });
    assert.strictEqual(result.passed, false);
    assert.ok(result.reasons.some((r) => r.includes("Website Visit CTA is required")));
  });

  it("Open Question: passes when the post ends on a question", () => {
    const result = validateGenerationCompliance({
      text: "We've all faced this problem before. What would you do differently?",
      angle: "Educational",
      pattern: pattern({ ctaType: "Open Question" }),
    });
    assert.strictEqual(result.passed, true);
  });

  it("Open Question: fails when the post does not end on a question", () => {
    const result = validateGenerationCompliance({
      text: "We've all faced this problem before, and it rarely gets easier with time.",
      angle: "Educational",
      pattern: pattern({ ctaType: "Open Question" }),
    });
    assert.strictEqual(result.passed, false);
    assert.ok(result.reasons.some((r) => r.includes("Open Question CTA is required")));
  });

  it("No CTA: passes with plain text and no CTA of any kind — never fails merely because no CTA exists", () => {
    const result = validateGenerationCompliance({
      text: "Here is a simple observation about the topic, with no call to action at all.",
      angle: "Educational",
      pattern: pattern({ ctaType: "No CTA" }),
    });
    assert.strictEqual(result.passed, true);
    assert.deepEqual(result.reasons, []);
  });

  it("Try It and No CTA are left unchecked — no defensible deterministic signal", () => {
    // "Try It" has no low-false-positive phrasing to match on, and "No CTA" is
    // an ABSENCE we never verify — reporting either as checked would certify
    // something that was never tested.
    const text = "Just some plain text with nothing that resembles any CTA at all.";
    const tryIt = validateGenerationCompliance({
      text,
      angle: "Educational",
      pattern: pattern({ ctaType: "Try It" }),
    });
    const noCta = validateGenerationCompliance({
      text,
      angle: "Educational",
      pattern: pattern({ ctaType: "No CTA" }),
    });
    assert.strictEqual(tryIt.passed, true);
    assert.strictEqual(tryIt.checked.cta, false);
    assert.strictEqual(noCta.passed, true);
    assert.strictEqual(noCta.checked.cta, false);
  });
});

// ─── CTA: Reflection ────────────────────────────────────────────────────────
// Two conditions, both required: the prompt must CLOSE the post, and it must
// address the reader. Dropping either one is what turns this into "accepts any
// question anywhere", which is exactly what it must not be.

describe("validateGenerationCompliance — Reflection CTA", () => {
  const reflection = (text: string) =>
    validateGenerationCompliance({
      text,
      angle: "Educational",
      pattern: pattern({ ctaType: "Reflection" }),
    });

  it("passes on a Bulgarian reflective closing question", () => {
    const result = reflection(
      [
        "Есента носи по-ниски цени на самолетните билети.",
        "След 15 септември разликата стига до 30%.",
        "А вие къде бихте пътували тази есен?",
      ].join("\n")
    );
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.checked.cta, true);
  });

  it("passes on a Bulgarian reflective closing addressed with вас", () => {
    const result = reflection(
      [
        "Изборът на есенна дестинация зависи от много неща.",
        "Цената и времето рядко се подреждат едновременно.",
        "Какво е най-важно за вас при избора на есенно пътуване?",
      ].join("\n")
    );
    assert.strictEqual(result.passed, true);
  });

  it("passes on an English reflective closing question", () => {
    const result = reflection(
      [
        "Autumn fares drop sharply once the school holidays end.",
        "The difference reaches 30% after the middle of September.",
        "Which of these destinations would you choose first?",
      ].join("\n")
    );
    assert.strictEqual(result.passed, true);
  });

  it("passes on a reflective imperative prompt with no question mark", () => {
    const result = reflection(
      [
        "Есенните оферти изчезват бързо след средата на октомври.",
        "Замислете се колко от плановете си отлагате всяка година.",
      ].join("\n")
    );
    assert.strictEqual(result.passed, true);
  });

  it("fails when the only question is the opening hook, not a closing prompt", () => {
    // A question ABOUT the article is a hook. The CTA has to come at the end
    // and has to be aimed at the reader.
    const result = reflection(
      "Къде отиват пътниците тази есен? Топ 10 дестинации включват осем европейски града."
    );
    assert.strictEqual(result.passed, false);
    assert.ok(
      result.reasons.some((r) => r.includes("Reflection CTA is required")),
      `expected a Reflection reason, got: ${JSON.stringify(result.reasons)}`
    );
  });

  it("fails on a closing question that never addresses the reader", () => {
    const result = reflection(
      [
        "Есента носи по-ниски цени на самолетните билети.",
        "Но колко дълго ще продължи тази тенденция?",
      ].join("\n")
    );
    assert.strictEqual(result.passed, false);
  });

  it("fails when there is no question or reflective prompt at all", () => {
    const result = reflection(
      "Есента носи по-ниски цени на билетите. Разликата стига до 30% през октомври."
    );
    assert.strictEqual(result.passed, false);
    assert.ok(result.reasons.some((r) => r.includes("Reflection CTA is required")));
  });
});

// ─── Angle: Tips & Tricks ───────────────────────────────────────────────────

describe("validateGenerationCompliance — Tips & Tricks angle", () => {
  it("passes with 2 actionable tips (numbered list)", () => {
    const text = [
      "Planning a trip can feel overwhelming at first.",
      "1. Book your tickets at least two months in advance.",
      "2. Pack only what fits in a single carry-on bag.",
    ].join("\n");
    const result = validateGenerationCompliance({
      text,
      angle: "Tips & Tricks",
      pattern: pattern({ ctaType: "No CTA" }),
    });
    assert.strictEqual(result.passed, true);
    assert.deepEqual(result.reasons, []);
  });

  it("passes with 4 actionable tips (numbered list)", () => {
    const text = [
      "Here are some ways to travel smarter this year.",
      "1. Book your tickets at least two months in advance.",
      "2. Pack only what fits in a single carry-on bag.",
      "3. Check visa requirements a week before departure.",
      "4. Download offline maps before you lose signal.",
    ].join("\n");
    const result = validateGenerationCompliance({
      text,
      angle: "Tips & Tricks",
      pattern: pattern({ ctaType: "No CTA" }),
    });
    assert.strictEqual(result.passed, true);
  });

  it("fails with 0 tips (a single flowing sentence, no list)", () => {
    const result = validateGenerationCompliance({
      text: "Planning a trip to El Salvador is easier than most people think it is.",
      angle: "Tips & Tricks",
      pattern: pattern({ ctaType: "No CTA" }),
    });
    assert.strictEqual(result.passed, false);
    assert.ok(
      result.reasons.some((r) => r.includes("Tips & Tricks requires 2–4 actionable tips; found 0")),
      `expected a 0-tips reason, got: ${JSON.stringify(result.reasons)}`
    );
  });

  it("fails with one generic sentence plus a CTA — the CTA must not be counted as a tip", () => {
    const result = validateGenerationCompliance({
      text: "This destination is amazing for everyone. Follow us for more tips like this!",
      angle: "Tips & Tricks",
      pattern: pattern({ ctaType: "Follow" }),
    });
    assert.strictEqual(result.passed, false);
    assert.ok(
      result.reasons.some((r) => r.includes("Tips & Tricks requires 2–4 actionable tips; found 0")),
      `CTA sentence must not be counted as a tip, got: ${JSON.stringify(result.reasons)}`
    );
  });

  it("does not check tips for any angle other than Tips & Tricks", () => {
    const result = validateGenerationCompliance({
      text: "Just one plain sentence with nothing actionable in it at all.",
      angle: "Educational",
      pattern: pattern(),
    });
    assert.strictEqual(result.checked.angle, false);
  });
});

// ─── Hook: Contrast ─────────────────────────────────────────────────────────

describe("validateGenerationCompliance — Contrast hook", () => {
  it("passes on a valid Bulgarian contrast opening (вместо X — Y)", () => {
    const result = validateGenerationCompliance({
      text: "Вместо да чакате дълги опашки на летището, изберете нашия бърз онлайн чекин.",
      angle: "Educational",
      pattern: pattern({ hookType: "Contrast" }),
    });
    assert.strictEqual(result.passed, true);
  });

  it("passes on a valid Bulgarian contrast opening (повечето..., но)", () => {
    const result = validateGenerationCompliance({
      text: "Повечето туристи резервират скъпи обиколки, но опитните пътешественици намират тези скрити места.",
      angle: "Educational",
      pattern: pattern({ hookType: "Contrast" }),
    });
    assert.strictEqual(result.passed, true);
  });

  it("passes on a valid English contrast opening (while/whereas)", () => {
    const result = validateGenerationCompliance({
      text: "While most travelers book expensive tours, smart ones find these hidden gems for free.",
      angle: "Educational",
      pattern: pattern({ hookType: "Contrast" }),
    });
    assert.strictEqual(result.passed, true);
  });

  it("passes on a valid English contrast opening (instead of X, Y)", () => {
    const result = validateGenerationCompliance({
      text: "Instead of booking another crowded resort, try this quiet fishing village nearby.",
      angle: "Educational",
      pattern: pattern({ hookType: "Contrast" }),
    });
    assert.strictEqual(result.passed, true);
  });

  it("fails when the opening has no recognizable contrast construction", () => {
    const result = validateGenerationCompliance({
      text: "Traveling to El Salvador is a wonderful experience for the whole family.",
      angle: "Educational",
      pattern: pattern({ hookType: "Contrast" }),
    });
    assert.strictEqual(result.passed, false);
    assert.ok(result.reasons.some((r) => r.includes("Contrast hook is required")));
  });

  it("does not check the hook for any hookType other than Contrast", () => {
    const result = validateGenerationCompliance({
      text: "No contrast construction anywhere in this sentence at all.",
      angle: "Educational",
      pattern: pattern({ hookType: "Question" }),
    });
    assert.strictEqual(result.checked.hook, false);
  });
});

// ─── Angle: Myth vs Fact ────────────────────────────────────────────────────
// Deliberately conservative: BOTH halves of a debunk must be in the opening.
// A correction word on its own ("но", "actually") is ordinary connective prose
// and appears in nearly every post, so it can never carry this check alone.

describe("validateGenerationCompliance — Myth vs Fact angle", () => {
  const myth = (text: string) =>
    validateGenerationCompliance({ text, angle: "Myth vs Fact", pattern: pattern() });

  it("passes on the explicit Мит/Факт framing", () => {
    const result = myth(
      "Мит: есента е мъртъв сезон за пътуване. Факт: цените на билетите падат с 30% след 15 септември."
    );
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.checked.angle, true);
  });

  it("passes on natural Bulgarian phrasing without the words мит or факт", () => {
    const result = myth(
      "Често се смята, че есента е слаб сезон за пътуване. Всъщност цените падат с 30% след средата на септември."
    );
    assert.strictEqual(result.passed, true);
  });

  it("passes on the Bulgarian не X, а Y replacement construction", () => {
    const result = myth(
      "Не лятото, а есента е сезонът с най-изгодните оферти за европейските градове."
    );
    assert.strictEqual(result.passed, true);
  });

  it("passes on the English equivalent", () => {
    const result = myth(
      "Most people assume autumn is the low season for travel, but the data shows fares drop by 30%."
    );
    assert.strictEqual(result.passed, true);
  });

  it("fails on an ordinary question", () => {
    const result = myth("Кои са най-добрите дестинации за есенно пътуване тази година?");
    assert.strictEqual(result.passed, false);
    assert.ok(
      result.reasons.some((r) => r.includes("Myth vs Fact requires the opening")),
      `expected a Myth vs Fact reason, got: ${JSON.stringify(result.reasons)}`
    );
  });

  it("fails on a bold claim that never names a misconception", () => {
    const result = myth("Есента е най-добрият сезон за пътуване в Европа, а цените го доказват.");
    assert.strictEqual(result.passed, false);
  });

  it("does not check the angle for any angle other than Tips & Tricks or Myth vs Fact", () => {
    const result = validateGenerationCompliance({
      text: "Just one plain sentence with no misconception and nothing actionable.",
      angle: "Behind the Scenes",
      pattern: pattern(),
    });
    assert.strictEqual(result.checked.angle, false);
  });
});

// ─── Structure: List ────────────────────────────────────────────────────────
// The one structure with a countable instruction of its own: "Present 3–5
// points in a numbered or bulleted, scannable format."

describe("validateGenerationCompliance — List structure", () => {
  const list = (text: string) =>
    validateGenerationCompliance({
      text,
      angle: "Educational",
      pattern: pattern({ structure: "List" }),
    });

  it("passes with 3 numbered items", () => {
    const result = list(
      [
        "Три есенни дестинации, които си заслужават:",
        "1. Лисабон — слънце до края на октомври.",
        "2. Рим — половината опашки пред музеите.",
        "3. Прага — най-евтините нощувки за годината.",
      ].join("\n")
    );
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.checked.structure, true);
  });

  it("passes with 5 bulleted items", () => {
    const result = list(
      [
        "Пет неща, които да проверите преди есенно пътуване:",
        "- Валидността на паспорта.",
        "- Прогнозата за времето.",
        "- Застраховката за багажа.",
        "- Работното време на музеите.",
        "- Цените на трансфера от летището.",
      ].join("\n")
    );
    assert.strictEqual(result.passed, true);
  });

  it("fails with only 2 items", () => {
    const result = list(
      ["Две есенни дестинации:", "1. Лисабон — топло време.", "2. Рим — по-малко туристи."].join(
        "\n"
      )
    );
    assert.strictEqual(result.passed, false);
    assert.ok(
      result.reasons.some((r) =>
        r.includes("List structure requires 3–5 scannable list items; found 2")
      ),
      `expected a 2-item reason, got: ${JSON.stringify(result.reasons)}`
    );
  });

  it("fails with 6 items — the requirement is strictly 3–5", () => {
    const result = list(
      [
        "Шест идеи:",
        "1. Лисабон.",
        "2. Рим.",
        "3. Прага.",
        "4. Виена.",
        "5. Атина.",
        "6. Будапеща.",
      ].join("\n")
    );
    assert.strictEqual(result.passed, false);
    assert.ok(
      result.reasons.some((r) =>
        r.includes("List structure requires 3–5 scannable list items; found 6")
      )
    );
  });

  it("fails on a normal paragraph — commas are not list items", () => {
    const result = list(
      "Тази есен пътниците избират Лисабон, Рим, Прага, Виена и Атина, защото цените там падат най-рано."
    );
    assert.strictEqual(result.passed, false);
    assert.ok(
      result.reasons.some((r) =>
        r.includes("List structure requires 3–5 scannable list items; found 0")
      )
    );
  });

  it("does not count hashtag-only bullets as list items", () => {
    const result = list(
      [
        "Есенни дестинации:",
        "- #Лисабон",
        "- #Рим",
        "- #Прага",
        "- Резервирайте поне два месеца по-рано.",
      ].join("\n")
    );
    assert.strictEqual(result.passed, false);
    assert.ok(
      result.reasons.some((r) =>
        r.includes("List structure requires 3–5 scannable list items; found 1")
      ),
      `hashtag bullets must not count, got: ${JSON.stringify(result.reasons)}`
    );
  });

  it("ignores the trailing hashtag block when counting", () => {
    const result = list(
      [
        "Три есенни дестинации:",
        "1. Лисабон — слънце до края на октомври.",
        "2. Рим — половината опашки пред музеите.",
        "3. Прага — най-евтините нощувки за годината.",
        "#TravelNest #ЕсенскиПътувания",
      ].join("\n")
    );
    assert.strictEqual(result.passed, true);
  });

  it("does not check the structure for any structure other than List", () => {
    const result = validateGenerationCompliance({
      text: "Plain text with no particular narrative shape at all.",
      angle: "Educational",
      pattern: pattern({ structure: "Story Arc" }),
    });
    assert.strictEqual(result.checked.structure, false);
  });
});

// ─── Hook: Bold Statement is deliberately not checked ───────────────────────

describe("validateGenerationCompliance — Bold Statement hook is not_checked", () => {
  it("never evaluates the hook and never cites it as a reason", () => {
    // The only deterministic signal available is one-sided — we could tell that
    // an opening is NOT a claim (it is a question), but never that a claim is
    // confident or counterintuitive. Reporting that as "checked and passed"
    // would certify nothing, which is the defect `status` exists to remove.
    const result = validateGenerationCompliance({
      text: "Есента е най-добрият момент за пътуване, но къде отиват пътниците?",
      angle: "Educational",
      pattern: pattern({ hookType: "Bold Statement" }),
    });
    assert.strictEqual(result.checked.hook, false);
    assert.ok(!result.reasons.some((r) => /bold statement/i.test(r)));
  });
});

// ─── Zero checked requirements ──────────────────────────────────────────────

describe("validateGenerationCompliance — nothing checkable", () => {
  it("reports not_checked instead of a verified pass when no dimension is measurable", () => {
    const result = validateGenerationCompliance({
      text: "Плътен текст, който не следва нито един измерим модел.",
      angle: "Behind the Scenes",
      pattern: { hookType: "Bold Statement", structure: "Story Arc", ctaType: "Try It" },
    });

    assert.strictEqual(result.status, "not_checked");
    assert.strictEqual(result.evaluated, false);
    assert.deepEqual(result.reasons, []);
    assert.deepEqual(result.checked, {
      angle: false,
      hook: false,
      cta: false,
      structure: false,
    });
    // Non-blocking: `passed` stays true so an unverifiable pattern never causes
    // a retry or an abort. `status` is what says it was never verified.
    assert.strictEqual(result.passed, true);
  });

  it("reports status passed only when something was actually checked and cleared", () => {
    const result = validateGenerationCompliance({
      text: "Полезен съвет за пътуване. Следвайте ни за още идеи.",
      angle: "Educational",
      pattern: pattern({ ctaType: "Follow" }),
    });
    assert.strictEqual(result.status, "passed");
    assert.strictEqual(result.evaluated, true);
    assert.strictEqual(result.passed, true);
  });

  it("reports status failed when a checked requirement was missed", () => {
    const result = validateGenerationCompliance({
      text: "Полезен съвет за пътуване и нищо повече.",
      angle: "Educational",
      pattern: pattern({ ctaType: "Follow" }),
    });
    assert.strictEqual(result.status, "failed");
    assert.strictEqual(result.evaluated, true);
    assert.strictEqual(result.passed, false);
  });
});

// ─── The real production failure, reproduced ───────────────────────────────

describe("validateGenerationCompliance — regression: the real accepted-but-noncompliant post", () => {
  it("fails a Tips & Tricks / Contrast / Follow post with 0 tips and no Follow CTA", () => {
    // Angle: Tips & Tricks, Hook: Contrast, CTA: Follow — the exact pattern from
    // the real trace. The post was accepted with 0 tips and no Follow CTA.
    const text =
      "Планирайте пътуване в Ел Салвадор и избягвайте шаблонните курорти — това е най-лесният начин да намерите дестинация с висока сигурност и отлични условия за сърф.";

    const result = validateGenerationCompliance({
      text,
      angle: "Tips & Tricks",
      pattern: { hookType: "Contrast", structure: "Story Arc", ctaType: "Follow" },
    });

    assert.strictEqual(result.passed, false);
    assert.ok(
      result.reasons.some((r) => r.includes("Tips & Tricks requires 2–4 actionable tips; found 0")),
      `must fail for 0 tips, got: ${JSON.stringify(result.reasons)}`
    );
    assert.ok(
      result.reasons.some((r) => r.includes("Follow CTA is required")),
      `must fail for missing Follow CTA, got: ${JSON.stringify(result.reasons)}`
    );
    // Story Arc must never be the reason — it is not deterministically checked.
    assert.ok(
      !result.reasons.some((r) => /story arc/i.test(r)),
      "Story Arc must never be cited as a failure reason"
    );
  });
});

// ─── The second real production failure, reproduced verbatim ───────────────
// The trace for this post read "Passed: true" with cta/hook/angle/structure all
// false — the gate had checked nothing and reported success anyway. Three of
// the four dimensions are measurable, and this post misses all three.

describe("validateGenerationCompliance — regression: the real TravelNest post", () => {
  const TRAVELNEST_TEXT =
    "Есента е най-добрият момент за пътуване, но къде отиват пътниците? " +
    "Топ 10 дестинации за тази година включват 8 европейски градове и два мексикански курорта. " +
    "#TravelNest #ЕсенскиПътувания";

  it("fails, and fails for all three measurable requirements", () => {
    const result = validateGenerationCompliance({
      text: TRAVELNEST_TEXT,
      angle: "Myth vs Fact",
      pattern: { hookType: "Bold Statement", structure: "List", ctaType: "Reflection" },
    });

    assert.strictEqual(result.status, "failed");
    assert.strictEqual(result.evaluated, true);
    assert.strictEqual(result.passed, false);

    assert.ok(
      result.reasons.some((r) => r.includes("Myth vs Fact requires the opening")),
      `must fail Myth vs Fact, got: ${JSON.stringify(result.reasons)}`
    );
    assert.ok(
      result.reasons.some((r) =>
        r.includes("List structure requires 3–5 scannable list items; found 0")
      ),
      `must fail List, got: ${JSON.stringify(result.reasons)}`
    );
    assert.ok(
      result.reasons.some((r) => r.includes("Reflection CTA is required")),
      `must fail Reflection, got: ${JSON.stringify(result.reasons)}`
    );
  });

  it("reports exactly which dimensions were and were not evaluated", () => {
    const result = validateGenerationCompliance({
      text: TRAVELNEST_TEXT,
      angle: "Myth vs Fact",
      pattern: { hookType: "Bold Statement", structure: "List", ctaType: "Reflection" },
    });

    assert.deepEqual(result.checked, {
      angle: true,
      hook: false, // Bold Statement — documented as not deterministically measurable
      cta: true,
      structure: true,
    });
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
    });
  });
});
