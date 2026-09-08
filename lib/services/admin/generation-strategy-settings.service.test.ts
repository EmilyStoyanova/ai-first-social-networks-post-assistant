import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getGenerationStrategySettings,
  readGenerationStrategySettings,
  updateGenerationStrategySettings,
  type GenerationStrategySettingsDb,
} from "./generation-strategy-settings.service";
import { DEFAULT_STRATEGY_SETTINGS } from "@/lib/ai/strategy/resolve-strategy";

type Row = {
  defaultStrategy: "single" | "multi";
  experimentEnabled: boolean;
  experimentKey: string | null;
  experimentAllocationPercent: number;
  updatedAt: Date;
};

function fakeDb(initial: Row | null): GenerationStrategySettingsDb & { row: Row | null } {
  const state: { row: Row | null } = { row: initial };
  return {
    get row() {
      return state.row;
    },
    generationStrategySettings: {
      findUnique: async () => state.row,
      upsert: async ({ create, update }) => {
        const patch = state.row ? update : create;
        state.row = {
          defaultStrategy: patch.defaultStrategy,
          experimentEnabled: patch.experimentEnabled,
          experimentKey: patch.experimentKey,
          experimentAllocationPercent: patch.experimentAllocationPercent,
          updatedAt: new Date("2026-09-08T00:00:00Z"),
        };
        return state.row;
      },
    },
  };
}

describe("getGenerationStrategySettings", () => {
  it("returns the defaults when no row exists", async () => {
    const s = await getGenerationStrategySettings(fakeDb(null));
    assert.deepEqual(s, DEFAULT_STRATEGY_SETTINGS);
  });

  it("returns the defaults — never throws — when the read fails", async () => {
    const db: GenerationStrategySettingsDb = {
      generationStrategySettings: {
        findUnique: async () => {
          throw new Error("db down");
        },
        upsert: async () => {
          throw new Error("unreachable");
        },
      },
    };
    const s = await getGenerationStrategySettings(db);
    assert.deepEqual(s, DEFAULT_STRATEGY_SETTINGS);
  });

  it("clamps a stored out-of-range allocation on the way out", async () => {
    const s = await getGenerationStrategySettings(
      fakeDb({
        defaultStrategy: "single",
        experimentEnabled: true,
        experimentKey: "k",
        experimentAllocationPercent: 999,
        updatedAt: new Date(),
      })
    );
    assert.equal(s.experimentAllocationPercent, 100);
  });
});

describe("readGenerationStrategySettings — admin view", () => {
  it("refuses a non-admin", async () => {
    const r = await readGenerationStrategySettings(false, fakeDb(null));
    assert.deepEqual(r, { success: false, code: "FORBIDDEN" });
  });

  it("reports updatedAt: null when nothing has been saved", async () => {
    const r = await readGenerationStrategySettings(true, fakeDb(null));
    assert.ok(r.success);
    assert.equal(r.settings.updatedAt, null);
  });
});

describe("updateGenerationStrategySettings", () => {
  it("refuses a non-admin", async () => {
    const r = await updateGenerationStrategySettings(false, "u1", { defaultStrategy: "multi" });
    assert.deepEqual(r, { success: false, code: "FORBIDDEN" });
  });

  it("mints an experiment key on the first enable", async () => {
    const db = fakeDb(null);
    const r = await updateGenerationStrategySettings(
      true,
      "u1",
      { experimentEnabled: true },
      { db, newExperimentKey: () => "exp-minted-1" }
    );
    assert.ok(r.success);
    assert.equal(r.settings.experimentKey, "exp-minted-1");
  });

  it("REUSES the key when an experiment is toggled off and on again", async () => {
    const db = fakeDb(null);
    await updateGenerationStrategySettings(
      true,
      "u1",
      { experimentEnabled: true },
      { db, newExperimentKey: () => "exp-first" }
    );
    await updateGenerationStrategySettings(true, "u1", { experimentEnabled: false }, { db });
    const again = await updateGenerationStrategySettings(
      true,
      "u1",
      { experimentEnabled: true },
      { db, newExperimentKey: () => "exp-second-SHOULD-NOT-BE-USED" }
    );
    assert.ok(again.success);
    assert.equal(again.settings.experimentKey, "exp-first");
  });

  it("resetKey mints a NEW key even when one already exists", async () => {
    const db = fakeDb({
      defaultStrategy: "single",
      experimentEnabled: true,
      experimentKey: "exp-old",
      experimentAllocationPercent: 50,
      updatedAt: new Date(),
    });
    const r = await updateGenerationStrategySettings(
      true,
      "u1",
      { resetKey: true },
      { db, newExperimentKey: () => "exp-brand-new" }
    );
    assert.ok(r.success);
    assert.equal(r.settings.experimentKey, "exp-brand-new");
  });

  it("rejects a non-integer or out-of-range allocation", async () => {
    for (const bad of [-1, 101, 33.3]) {
      const r = await updateGenerationStrategySettings(true, "u1", {
        experimentAllocationPercent: bad,
      });
      assert.deepEqual(r, { success: false, code: "INVALID_ALLOCATION" }, `allowed ${bad}`);
    }
  });

  it("changes only the fields it was given", async () => {
    const db = fakeDb({
      defaultStrategy: "single",
      experimentEnabled: false,
      experimentKey: null,
      experimentAllocationPercent: 50,
      updatedAt: new Date(),
    });
    const r = await updateGenerationStrategySettings(
      true,
      "u1",
      { defaultStrategy: "multi" },
      { db }
    );
    assert.ok(r.success);
    assert.equal(r.settings.defaultStrategy, "multi");
    assert.equal(r.settings.experimentEnabled, false);
    assert.equal(r.settings.experimentKey, null);
  });
});
