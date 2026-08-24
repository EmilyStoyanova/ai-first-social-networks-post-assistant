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

  it("Reflection and Try It are left unchecked (no defensible deterministic signal)", () => {
    const text = "Just some plain text with nothing that resembles any CTA at all.";
    const reflection = validateGenerationCompliance({
      text,
      angle: "Educational",
      pattern: pattern({ ctaType: "Reflection" }),
    });
    const tryIt = validateGenerationCompliance({
      text,
      angle: "Educational",
      pattern: pattern({ ctaType: "Try It" }),
    });
    assert.strictEqual(reflection.passed, true);
    assert.strictEqual(reflection.checked.cta, false);
    assert.strictEqual(tryIt.passed, true);
    assert.strictEqual(tryIt.checked.cta, false);
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

// ─── Structure — deliberately not checked ──────────────────────────────────

describe("validateGenerationCompliance — Structure is never checked", () => {
  it("Story Arc is always reported as checked.structure = false and never fails on it", () => {
    const result = validateGenerationCompliance({
      text: "Plain text with no particular narrative shape at all.",
      angle: "Educational",
      pattern: pattern({ structure: "Story Arc" }),
    });
    assert.strictEqual(result.checked.structure, false);
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

describe("NO_COMPLIANCE_CHECK", () => {
  it("is a neutral pass with nothing checked", () => {
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
