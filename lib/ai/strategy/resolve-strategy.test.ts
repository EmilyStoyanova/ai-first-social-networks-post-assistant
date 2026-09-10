import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assignmentBucket,
  BUCKET_SPACE,
  clampAllocation,
  resolveGenerationStrategy,
  resolvedStrategySchema,
  SINGLE_BY_DEFAULT,
  type StrategySettingsSnapshot,
} from "./resolve-strategy";

const NO_EXPERIMENT: StrategySettingsSnapshot = {
  defaultStrategy: "single",
  experimentEnabled: false,
  experimentKey: null,
  experimentAllocationPercent: 50,
};

const LIVE_EXPERIMENT: StrategySettingsSnapshot = {
  defaultStrategy: "single",
  experimentEnabled: true,
  experimentKey: "exp-alpha",
  experimentAllocationPercent: 50,
};

describe("resolveGenerationStrategy — precedence", () => {
  it("an explicit single override wins over a running experiment", () => {
    const r = resolveGenerationStrategy({
      override: "single",
      stableUnitId: "unit-1",
      settings: LIVE_EXPERIMENT,
    });
    assert.equal(r.strategy, "single");
    assert.equal(r.source, "user_override");
    // An override is never an experiment assignment — no arm, no key.
    assert.equal(r.experimentArm, null);
    assert.equal(r.experimentKey, null);
  });

  it("an explicit multi override wins over the site default", () => {
    const r = resolveGenerationStrategy({
      override: "multi",
      stableUnitId: "unit-1",
      settings: { ...NO_EXPERIMENT, defaultStrategy: "single" },
    });
    assert.equal(r.strategy, "multi");
    assert.equal(r.source, "user_override");
  });

  it("A/B assignment wins over the global default when eligible", () => {
    const r = resolveGenerationStrategy({
      override: "site_default",
      stableUnitId: "unit-1",
      settings: LIVE_EXPERIMENT,
    });
    assert.equal(r.source, "ab_split");
    assert.equal(r.experimentKey, "exp-alpha");
    assert.ok(r.strategy === "single" || r.strategy === "multi");
    assert.equal(r.strategy, r.experimentArm);
  });

  it("falls back to the site default when there is no experiment", () => {
    const r = resolveGenerationStrategy({
      stableUnitId: "unit-1",
      settings: { ...NO_EXPERIMENT, defaultStrategy: "multi" },
    });
    assert.equal(r.strategy, "multi");
    assert.equal(r.source, "global_default");
    assert.equal(r.abIneligibleReason, null);
  });
});

describe("resolveGenerationStrategy — eligibility", () => {
  it("an explicit model choice keeps a run out of the experiment", () => {
    const r = resolveGenerationStrategy({
      stableUnitId: "unit-1",
      settings: LIVE_EXPERIMENT,
      hasExplicitLlmConfig: true,
    });
    assert.equal(r.source, "global_default");
    assert.equal(r.abIneligibleReason, "explicit_model_choice");
  });

  it("an unavailable pinned model keeps a run out of the experiment", () => {
    const r = resolveGenerationStrategy({
      stableUnitId: "unit-1",
      settings: LIVE_EXPERIMENT,
      pinnedModelAvailable: false,
    });
    assert.equal(r.source, "global_default");
    assert.equal(r.abIneligibleReason, "pinned_model_unavailable");
  });

  it("a missing stable unit keeps a run out of the experiment", () => {
    const r = resolveGenerationStrategy({
      stableUnitId: null,
      settings: LIVE_EXPERIMENT,
    });
    assert.equal(r.source, "global_default");
    assert.equal(r.abIneligibleReason, "no_stable_unit");
  });

  it("a disabled experiment reports NO ineligibility reason — there is nothing to be ineligible for", () => {
    const r = resolveGenerationStrategy({
      stableUnitId: "unit-1",
      settings: NO_EXPERIMENT,
    });
    assert.equal(r.abIneligibleReason, null);
  });

  it("an enabled experiment with no key cannot assign", () => {
    const r = resolveGenerationStrategy({
      stableUnitId: "unit-1",
      settings: { ...LIVE_EXPERIMENT, experimentKey: null },
    });
    assert.equal(r.source, "global_default");
    assert.equal(r.abIneligibleReason, "no_experiment_key");
  });
});

describe("resolveGenerationStrategy — determinism", () => {
  it("the same unit and key always yield the same arm", () => {
    const once = resolveGenerationStrategy({
      stableUnitId: "topic-42",
      settings: LIVE_EXPERIMENT,
    });
    for (let i = 0; i < 50; i++) {
      const again = resolveGenerationStrategy({
        stableUnitId: "topic-42",
        settings: LIVE_EXPERIMENT,
      });
      assert.equal(again.strategy, once.strategy);
      assert.equal(again.experimentBucket, once.experimentBucket);
    }
  });

  it("a retry — a fresh resolve of the same unit — does not change the arm", () => {
    // There is no per-call state; the arm is a pure function of (key, unit).
    const a = resolveGenerationStrategy({ stableUnitId: "g1", settings: LIVE_EXPERIMENT });
    const b = resolveGenerationStrategy({ stableUnitId: "g1", settings: LIVE_EXPERIMENT });
    assert.deepEqual(a, b);
  });

  it("changing the experiment key can change a unit's assignment", () => {
    // Not guaranteed for one unit, but across many the two keys must disagree
    // somewhere — otherwise the key is not part of the hash.
    let disagreements = 0;
    for (let i = 0; i < 200; i++) {
      const unit = `unit-${i}`;
      const withA = resolveGenerationStrategy({
        stableUnitId: unit,
        settings: { ...LIVE_EXPERIMENT, experimentKey: "exp-alpha" },
      });
      const withB = resolveGenerationStrategy({
        stableUnitId: unit,
        settings: { ...LIVE_EXPERIMENT, experimentKey: "exp-beta" },
      });
      if (withA.strategy !== withB.strategy) disagreements++;
    }
    assert.ok(disagreements > 20, `keys barely changed anything: ${disagreements}/200`);
  });

  it("roughly honours a 50/50 split across many units", () => {
    let multi = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const r = resolveGenerationStrategy({
        stableUnitId: `content-group-${i}`,
        settings: LIVE_EXPERIMENT,
      });
      if (r.strategy === "multi") multi++;
    }
    const ratio = multi / N;
    assert.ok(ratio > 0.44 && ratio < 0.56, `split was ${ratio}`);
  });
});

describe("resolveGenerationStrategy — allocation boundaries", () => {
  it("allocation 0 assigns NOBODY to multi", () => {
    for (let i = 0; i < 500; i++) {
      const r = resolveGenerationStrategy({
        stableUnitId: `u-${i}`,
        settings: { ...LIVE_EXPERIMENT, experimentAllocationPercent: 0 },
      });
      assert.equal(r.strategy, "single");
      assert.equal(r.source, "ab_split"); // still assigned, just to the control arm
    }
  });

  it("allocation 100 assigns EVERYONE to multi", () => {
    for (let i = 0; i < 500; i++) {
      const r = resolveGenerationStrategy({
        stableUnitId: `u-${i}`,
        settings: { ...LIVE_EXPERIMENT, experimentAllocationPercent: 100 },
      });
      assert.equal(r.strategy, "multi");
    }
  });

  it("records the allocation as it stood at assignment time", () => {
    const r = resolveGenerationStrategy({
      stableUnitId: "u-1",
      settings: { ...LIVE_EXPERIMENT, experimentAllocationPercent: 70 },
    });
    assert.equal(r.experimentAllocation, 70);
  });
});

describe("assignmentBucket", () => {
  it("stays inside [0, BUCKET_SPACE)", () => {
    for (let i = 0; i < 1000; i++) {
      const b = assignmentBucket("exp", `unit-${i}`);
      assert.ok(b >= 0 && b < BUCKET_SPACE);
    }
  });

  it("the separator prevents key/unit ambiguity", () => {
    // Without the ':' these two would hash the same input.
    assert.notEqual(assignmentBucket("exp1", "23"), assignmentBucket("exp12", "3"));
  });
});

describe("clampAllocation", () => {
  it("clamps out-of-range and non-finite values instead of throwing", () => {
    assert.equal(clampAllocation(-10), 0);
    assert.equal(clampAllocation(150), 100);
    assert.equal(clampAllocation(Number.NaN), 0);
    assert.equal(clampAllocation(49.6), 50);
  });
});

describe("resolvedStrategySchema", () => {
  it("round-trips a resolved value through the wire form", () => {
    const r = resolveGenerationStrategy({ stableUnitId: "g", settings: LIVE_EXPERIMENT });
    const parsed = resolvedStrategySchema.parse(JSON.parse(JSON.stringify(r)));
    assert.deepEqual(parsed, r);
  });

  it("accepts SINGLE_BY_DEFAULT", () => {
    assert.deepEqual(resolvedStrategySchema.parse(SINGLE_BY_DEFAULT), SINGLE_BY_DEFAULT);
  });

  it("rejects a bucket outside the space", () => {
    const bad = { ...SINGLE_BY_DEFAULT, experimentBucket: BUCKET_SPACE };
    assert.throws(() => resolvedStrategySchema.parse(bad));
  });

  it("rejects an unknown extra field — the payload is strict", () => {
    assert.throws(() =>
      resolvedStrategySchema.parse({ ...SINGLE_BY_DEFAULT, sneaky: true } as unknown)
    );
  });
});
