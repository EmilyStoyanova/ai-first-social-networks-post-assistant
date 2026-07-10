import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  HOOK_TYPES,
  POST_STRUCTURES,
  CTA_TYPES,
  selectPattern,
  selectRetryPattern,
  isValidPostPattern,
  type PostPattern,
  type HookType,
  type PostStructure,
  type CtaType,
} from "./post-pattern";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function patternOf(hookType: HookType, structure: PostStructure, ctaType: CtaType): PostPattern {
  return { hookType, structure, ctaType };
}

// ─── selectPattern — first selection ─────────────────────────────────────────

describe("selectPattern — empty history", () => {
  it("returns the first value of each canonical list when history is empty", () => {
    const p = selectPattern([]);
    assert.strictEqual(p.hookType, HOOK_TYPES[0]);
    assert.strictEqual(p.structure, POST_STRUCTURES[0]);
    assert.strictEqual(p.ctaType, CTA_TYPES[0]);
  });
});

describe("selectPattern — avoids recently used values per dimension", () => {
  it("skips a recently used hookType and picks the next one", () => {
    const recent = [patternOf("Question", POST_STRUCTURES[0], CTA_TYPES[0])];
    const p = selectPattern(recent);
    assert.notStrictEqual(p.hookType, "Question");
    assert.strictEqual(p.hookType, HOOK_TYPES[1]);
  });

  it("each dimension is selected independently from its own history", () => {
    // hookType history: "Question" used; structure history: "Single Insight" used; cta history: "Comment Prompt" used
    const recent = [patternOf("Question", "Single Insight", "Comment Prompt")];
    const p = selectPattern(recent);
    assert.notStrictEqual(p.hookType, "Question");
    assert.notStrictEqual(p.structure, "Single Insight");
    assert.notStrictEqual(p.ctaType, "Comment Prompt");
  });

  it("returns the absent value when one hook type is missing from a nearly-full list", () => {
    const allExcept = HOOK_TYPES.filter((h) => h !== "Empathy");
    const recent = allExcept.map((h) => patternOf(h as HookType, POST_STRUCTURES[0], CTA_TYPES[0]));
    const p = selectPattern(recent);
    assert.strictEqual(p.hookType, "Empathy");
  });
});

describe("selectPattern — LRU fallback when all values are used", () => {
  it("returns the deepest hook type when every hook has been used", () => {
    // Build a history with all hooks in canonical order (most recent = first = HOOK_TYPES[0]).
    const recent = HOOK_TYPES.map((h) => patternOf(h, POST_STRUCTURES[0], CTA_TYPES[0]));
    const p = selectPattern(recent);
    // HOOK_TYPES[last] is deepest = least recent → should be selected.
    assert.strictEqual(p.hookType, HOOK_TYPES[HOOK_TYPES.length - 1]);
  });

  it("returns the deepest structure when every structure has been used", () => {
    const recent = POST_STRUCTURES.map((s) => patternOf(HOOK_TYPES[0], s, CTA_TYPES[0]));
    const p = selectPattern(recent);
    assert.strictEqual(p.structure, POST_STRUCTURES[POST_STRUCTURES.length - 1]);
  });

  it("returns the deepest CTA when every CTA has been used", () => {
    const recent = CTA_TYPES.map((c) => patternOf(HOOK_TYPES[0], POST_STRUCTURES[0], c));
    const p = selectPattern(recent);
    assert.strictEqual(p.ctaType, CTA_TYPES[CTA_TYPES.length - 1]);
  });
});

// ─── selectPattern — consecutive posts cannot share a pattern ─────────────────

describe("selectPattern — consecutive posts produce distinct patterns", () => {
  it("three consecutive selections all differ from each other on hookType", () => {
    const history: PostPattern[] = [];

    const p1 = selectPattern(history);
    history.unshift(p1); // most-recent-first

    const p2 = selectPattern(history);
    history.unshift(p2);

    const p3 = selectPattern(history);

    assert.notStrictEqual(p2.hookType, p1.hookType, "post 2 hookType must differ from post 1");
    assert.notStrictEqual(p3.hookType, p2.hookType, "post 3 hookType must differ from post 2");
  });

  it("three consecutive selections all differ from each other on structure", () => {
    const history: PostPattern[] = [];

    const p1 = selectPattern(history);
    history.unshift(p1);
    const p2 = selectPattern(history);
    history.unshift(p2);
    const p3 = selectPattern(history);

    assert.notStrictEqual(p2.structure, p1.structure, "post 2 structure must differ from post 1");
    assert.notStrictEqual(p3.structure, p2.structure, "post 3 structure must differ from post 2");
  });

  it("three consecutive selections all differ from each other on ctaType", () => {
    const history: PostPattern[] = [];

    const p1 = selectPattern(history);
    history.unshift(p1);
    const p2 = selectPattern(history);
    history.unshift(p2);
    const p3 = selectPattern(history);

    assert.notStrictEqual(p2.ctaType, p1.ctaType, "post 2 ctaType must differ from post 1");
    assert.notStrictEqual(p3.ctaType, p2.ctaType, "post 3 ctaType must differ from post 2");
  });
});

// ─── selectRetryPattern — always differs from current on all dimensions ───────

describe("selectRetryPattern — differs from current on all dimensions", () => {
  it("all three dimensions differ from the current pattern even with empty history", () => {
    const current = patternOf("Question", "Single Insight", "Comment Prompt");
    const retry = selectRetryPattern(current, []);
    assert.notStrictEqual(retry.hookType, current.hookType);
    assert.notStrictEqual(retry.structure, current.structure);
    assert.notStrictEqual(retry.ctaType, current.ctaType);
  });

  it("holds true for every possible single-entry current pattern", () => {
    const sample: PostPattern[] = [
      patternOf("Statistic", "List", "Reflection"),
      patternOf("Contrast", "Story Arc", "No CTA"),
      patternOf("Empathy", "How-To Steps", "Follow"),
    ];
    for (const current of sample) {
      const retry = selectRetryPattern(current, []);
      assert.notStrictEqual(retry.hookType, current.hookType, `hookType for ${current.hookType}`);
      assert.notStrictEqual(
        retry.structure,
        current.structure,
        `structure for ${current.structure}`
      );
      assert.notStrictEqual(retry.ctaType, current.ctaType, `ctaType for ${current.ctaType}`);
    }
  });
});

describe("selectRetryPattern — prefers values absent from recent history", () => {
  it("picks a hookType not present in recent history when one exists", () => {
    // recent has all hooks except "Empathy"; current hook is "Question"
    const recentHooks = HOOK_TYPES.filter((h) => h !== "Empathy" && h !== "Question");
    const recent = recentHooks.map((h) =>
      patternOf(h as HookType, POST_STRUCTURES[0], CTA_TYPES[0])
    );
    const retry = selectRetryPattern(
      patternOf("Question", POST_STRUCTURES[0], CTA_TYPES[0]),
      recent
    );
    assert.strictEqual(retry.hookType, "Empathy");
  });
});

describe("selectRetryPattern — fallback when all other values are in recent history", () => {
  it("never returns the current hookType even when every hookType is in recent history", () => {
    const recent = HOOK_TYPES.map((h) => patternOf(h, POST_STRUCTURES[0], CTA_TYPES[0]));
    for (const current of HOOK_TYPES) {
      const retry = selectRetryPattern(
        patternOf(current, POST_STRUCTURES[0], CTA_TYPES[0]),
        recent
      );
      assert.notStrictEqual(retry.hookType, current, `hookType for current="${current}"`);
    }
  });
});

describe("selectRetryPattern — consecutive retries produce distinct patterns", () => {
  it("three retry attempts all differ from each other and from the initial pattern", () => {
    const history: PostPattern[] = [];
    const triedPatterns: PostPattern[] = [selectPattern(history)];

    for (let i = 1; i < 3; i++) {
      const combined = [...history, ...triedPatterns];
      const next = selectRetryPattern(triedPatterns[i - 1], combined);
      assert.notStrictEqual(
        next.hookType,
        triedPatterns[i - 1].hookType,
        `retry ${i} hookType must differ from previous`
      );
      assert.notStrictEqual(
        next.structure,
        triedPatterns[i - 1].structure,
        `retry ${i} structure must differ from previous`
      );
      assert.notStrictEqual(
        next.ctaType,
        triedPatterns[i - 1].ctaType,
        `retry ${i} ctaType must differ from previous`
      );
      triedPatterns.push(next);
    }

    // All tried hook types are distinct.
    const hookSet = new Set(triedPatterns.map((p) => p.hookType));
    assert.strictEqual(hookSet.size, triedPatterns.length, "all tried hookTypes must be unique");
  });
});

// ─── isValidPostPattern ───────────────────────────────────────────────────────

describe("isValidPostPattern", () => {
  it("returns true for a valid PostPattern object", () => {
    assert.ok(isValidPostPattern({ hookType: "Question", structure: "List", ctaType: "Share" }));
  });

  it("returns false for an object with an unknown hookType", () => {
    assert.ok(!isValidPostPattern({ hookType: "Unknown", structure: "List", ctaType: "Share" }));
  });

  it("returns false for null", () => {
    assert.ok(!isValidPostPattern(null));
  });

  it("returns false for a partial object", () => {
    assert.ok(!isValidPostPattern({ hookType: "Question" }));
  });
});
