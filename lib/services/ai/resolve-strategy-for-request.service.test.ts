import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveStrategyForRequest,
  resolveStrategiesForUnits,
} from "./resolve-strategy-for-request.service";
import type { GenerationStrategySettingsDb } from "@/lib/services/admin/generation-strategy-settings.service";

function settingsDb(row: {
  defaultStrategy?: "single" | "multi";
  experimentEnabled?: boolean;
  experimentKey?: string | null;
  experimentAllocationPercent?: number;
}): GenerationStrategySettingsDb & { reads: number } {
  const state = { reads: 0 };
  return {
    get reads() {
      return state.reads;
    },
    generationStrategySettings: {
      findUnique: async () => {
        state.reads++;
        return {
          defaultStrategy: row.defaultStrategy ?? "single",
          experimentEnabled: row.experimentEnabled ?? false,
          experimentKey: row.experimentKey ?? null,
          experimentAllocationPercent: row.experimentAllocationPercent ?? 50,
          updatedAt: new Date(),
        };
      },
      upsert: async () => {
        throw new Error("not used");
      },
    },
  };
}

describe("resolveStrategyForRequest", () => {
  it("uses the site default when no experiment and no override", async () => {
    const r = await resolveStrategyForRequest(
      { stableUnitId: "g1" },
      { db: settingsDb({ defaultStrategy: "multi" }), pinnedModelAvailable: () => true }
    );
    assert.equal(r.strategy, "multi");
    assert.equal(r.source, "global_default");
  });

  it("honours an explicit override over a running experiment", async () => {
    const r = await resolveStrategyForRequest(
      { stableUnitId: "g1", override: "single" },
      {
        db: settingsDb({
          experimentEnabled: true,
          experimentKey: "e",
          experimentAllocationPercent: 100,
        }),
        pinnedModelAvailable: () => true,
      }
    );
    assert.equal(r.strategy, "single");
    assert.equal(r.source, "user_override");
  });

  it("passes the pinned-model availability through to eligibility", async () => {
    const r = await resolveStrategyForRequest(
      { stableUnitId: "g1" },
      {
        db: settingsDb({ experimentEnabled: true, experimentKey: "e" }),
        pinnedModelAvailable: () => false,
      }
    );
    assert.equal(r.source, "global_default");
    assert.equal(r.abIneligibleReason, "pinned_model_unavailable");
  });

  it("never throws when the settings read fails — degrades to single", async () => {
    const db: GenerationStrategySettingsDb = {
      generationStrategySettings: {
        findUnique: async () => {
          throw new Error("down");
        },
        upsert: async () => {
          throw new Error("down");
        },
      },
    };
    const r = await resolveStrategyForRequest(
      { stableUnitId: "g1" },
      { db, pinnedModelAvailable: () => true }
    );
    assert.equal(r.strategy, "single");
    assert.equal(r.source, "global_default");
  });
});

describe("resolveStrategiesForUnits", () => {
  it("reads the settings ONCE for the whole batch", async () => {
    const db = settingsDb({ experimentEnabled: true, experimentKey: "e" });
    await resolveStrategiesForUnits(
      ["a", "b", "c", "d", "e"],
      {},
      { db, pinnedModelAvailable: () => true }
    );
    assert.equal(db.reads, 1);
  });

  it("assigns each unit independently — one array entry per unit, in order", async () => {
    const db = settingsDb({
      experimentEnabled: true,
      experimentKey: "e",
      experimentAllocationPercent: 50,
    });
    const units = Array.from({ length: 40 }, (_, i) => `topic-${i}`);
    const out = await resolveStrategiesForUnits(
      units,
      {},
      { db, pinnedModelAvailable: () => true }
    );
    assert.equal(out.length, 40);
    out.forEach((r, i) => assert.equal(r.experimentUnitId, units[i]));
    // A 50/50 split over 40 units should produce at least one of each arm.
    assert.ok(out.some((r) => r.strategy === "multi"));
    assert.ok(out.some((r) => r.strategy === "single"));
  });

  it("gives the same unit the same arm whether resolved alone or in a batch", async () => {
    const opts = {
      db: settingsDb({ experimentEnabled: true, experimentKey: "e" }),
      pinnedModelAvailable: () => true,
    };
    const alone = await resolveStrategyForRequest({ stableUnitId: "topic-7" }, opts);
    const [inBatch] = await resolveStrategiesForUnits(["topic-7"], {}, opts);
    assert.equal(alone.strategy, inBatch.strategy);
    assert.equal(alone.experimentBucket, inBatch.experimentBucket);
  });
});
