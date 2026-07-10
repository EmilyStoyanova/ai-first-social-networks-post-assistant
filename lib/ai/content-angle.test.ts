import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CONTENT_ANGLES, selectAngle, selectRetryAngle, type ContentAngle } from "./content-angle";

// ─── selectAngle ──────────────────────────────────────────────────────────────

describe("selectAngle — no recent angles", () => {
  it("returns the first angle in the canonical list when history is empty", () => {
    const angle = selectAngle([]);
    assert.strictEqual(angle, "Educational");
  });
});

describe("selectAngle — avoids recently used angles", () => {
  it("skips the most-recently-used angle and returns the next available one", () => {
    const angle = selectAngle(["Educational"]);
    assert.strictEqual(angle, "Tips & Tricks");
  });

  it("returns the one angle absent from a nearly-full recent list", () => {
    const recentAngles = CONTENT_ANGLES.filter((a) => a !== "FAQ") as ContentAngle[];
    const angle = selectAngle(recentAngles);
    assert.strictEqual(angle, "FAQ");
  });
});

describe("selectAngle — all angles used (LRU fallback)", () => {
  it("returns the angle deepest in the recents list when every angle has been used", () => {
    // recentAngles is most-recent-first, so index 0 = newest, last index = oldest.
    // When the full list appears in canonical order, "Comparison" sits at the end → least recent.
    const recentAngles = [...CONTENT_ANGLES] as ContentAngle[];
    const angle = selectAngle(recentAngles);
    assert.strictEqual(angle, "Comparison");
  });

  it("picks the correct LRU when the order differs from canonical", () => {
    // Make "Inspirational" the deepest (least recent) by placing it last.
    const recentAngles = [
      ...CONTENT_ANGLES.filter((a) => a !== "Inspirational"),
      "Inspirational",
    ] as ContentAngle[];
    const angle = selectAngle(recentAngles);
    assert.strictEqual(angle, "Inspirational");
  });
});

// ─── selectRetryAngle ─────────────────────────────────────────────────────────

describe("selectRetryAngle — never returns the current angle", () => {
  it("avoids the current angle even when history is empty", () => {
    const retry = selectRetryAngle("Educational", []);
    assert.notStrictEqual(retry, "Educational");
    assert.strictEqual(retry, "Tips & Tricks");
  });

  it("avoids the current angle even when it is in the middle of the canonical list", () => {
    const retry = selectRetryAngle("FAQ", []);
    assert.notStrictEqual(retry, "FAQ");
    assert.strictEqual(retry, "Educational");
  });
});

describe("selectRetryAngle — prefers angles absent from recent history", () => {
  it("picks the first unused angle that is not the current one", () => {
    // recent = everything except "FAQ" and "Educational" (current)
    const recentAngles = CONTENT_ANGLES.filter(
      (a) => a !== "FAQ" && a !== "Educational"
    ) as ContentAngle[];
    const retry = selectRetryAngle("Educational", recentAngles);
    assert.strictEqual(retry, "FAQ");
  });
});

describe("selectRetryAngle — fallback when all other angles are in recent history", () => {
  it("returns the non-current angle that appears deepest in the recents list", () => {
    // All 15 angles in canonical order → "Educational" at index 0 (most recent / current),
    // "Comparison" at index 14 (least recent, deepest).
    const recentAngles = [...CONTENT_ANGLES] as ContentAngle[];
    const retry = selectRetryAngle("Educational", recentAngles);
    assert.notStrictEqual(retry, "Educational");
    assert.strictEqual(retry, "Comparison");
  });

  it("never returns the current angle even in the full-recents fallback path", () => {
    for (const current of CONTENT_ANGLES) {
      const recentAngles = [...CONTENT_ANGLES] as ContentAngle[];
      const retry = selectRetryAngle(current, recentAngles);
      assert.notStrictEqual(retry, current, `retry should differ from current angle "${current}"`);
    }
  });
});

describe("selectRetryAngle — consecutive retries pick distinct angles", () => {
  it("each successive retry gets a different angle than all prior attempts", () => {
    const recentAngles: ContentAngle[] = [];
    const triedAngles: ContentAngle[] = [selectAngle(recentAngles)];

    for (let i = 1; i < 3; i++) {
      const combined = [...recentAngles, ...triedAngles.slice(0, i)] as ContentAngle[];
      const next = selectRetryAngle(triedAngles[i - 1], combined);
      assert.ok(
        !triedAngles.includes(next),
        `retry ${i} angle "${next}" should not already have been tried`
      );
      triedAngles.push(next);
    }

    // All three angles in this run must be distinct.
    assert.strictEqual(
      new Set(triedAngles).size,
      triedAngles.length,
      "all tried angles must be unique"
    );
  });
});
