import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  recomputeRelevanceForRow,
  recomputeStaleRelevanceForCompany,
  staleWhere,
  type RecomputeRelevanceDb,
  type RelevanceRow,
} from "./recompute-stale-relevance.service";
import type { RelevanceProfile } from "@/lib/ai/competitor-relevance";
import type { ILlmProvider } from "@/lib/ai/types";

const VALID_REPLY = (topic: string) =>
  JSON.stringify({
    relevance: "relevant",
    reason: "Centrally about the topic.",
    matchedResearchTopics: [topic],
  });

function row(overrides: Partial<RelevanceRow> = {}): RelevanceRow {
  return {
    id: "ci-1",
    competitorId: "c-1",
    relevanceProfileVersion: null,
    topic: "home insulation",
    subtopic: null,
    summary: null,
    angle: null,
    keyMessage: null,
    targetAudience: null,
    problemAddressed: null,
    productsServicesMentioned: [],
    ...overrides,
  };
}

function makeFakeDb(archivedAt: Date | null = null) {
  const writes: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  // Per-ROW version state, keyed by id — a single shared variable here would
  // make row B's write incorrectly guard against row A's just-written
  // version, which is not how the real optimistic-concurrency check works
  // (it is scoped per row via `relevanceProfileVersion` in the WHERE).
  const versionByRow = new Map<string, number | null>();
  const stored: Record<string, unknown> = {};
  const db: RecomputeRelevanceDb = {
    competitorIntelligence: {
      updateMany: async ({ where, data }) => {
        writes.push({ where, data });
        const w = where as { id: string; relevanceProfileVersion: number | null };
        const current = versionByRow.has(w.id) ? versionByRow.get(w.id)! : null;
        if (current !== w.relevanceProfileVersion) {
          return { count: 0 };
        }
        versionByRow.set(
          w.id,
          (data as { relevanceProfileVersion?: number }).relevanceProfileVersion ?? current
        );
        Object.assign(stored, data);
        return { count: 1 };
      },
    },
    competitor: { findFirst: async () => ({ archivedAt }) },
  };
  return { db, writes, stored };
}

function okProvider(topic: string) {
  return async () => ({
    ok: true as const,
    instance: { generate: async () => ({ text: VALID_REPLY(topic) }) } as ILlmProvider,
    provider: "test",
    model: "test-model",
  });
}

const PROFILE: RelevanceProfile = { researchTopics: ["home insulation"], markets: [] };
const EMPTY_PROFILE: RelevanceProfile = { researchTopics: [], markets: [] };

describe("recomputeRelevanceForRow — archived (§5, fresh per-row check)", () => {
  it("skips a row whose competitor is currently archived", async () => {
    const { db } = makeFakeDb(new Date());
    const outcome = await recomputeRelevanceForRow(row(), PROFILE, 1, {
      db,
      resolveProvider: okProvider("home insulation"),
    });
    assert.deepEqual(outcome, { status: "skipped", reason: "archived" });
  });

  it("proceeds when the competitor is not archived", async () => {
    const { db } = makeFakeDb(null);
    const outcome = await recomputeRelevanceForRow(row(), PROFILE, 1, {
      db,
      resolveProvider: okProvider("home insulation"),
    });
    assert.deepEqual(outcome, { status: "updated" });
  });
});

describe("recomputeRelevanceForRow — no research interests configured", () => {
  it("settles to out_of_scope with NO model call", async () => {
    let called = false;
    const { db, stored } = makeFakeDb(null);
    const outcome = await recomputeRelevanceForRow(row(), EMPTY_PROFILE, 1, {
      db,
      resolveProvider: async () => {
        called = true;
        return {
          ok: true,
          instance: { generate: async () => ({ text: "" }) },
          provider: "t",
          model: "m",
        };
      },
    });
    assert.deepEqual(outcome, { status: "updated" });
    assert.equal(called, false);
    assert.equal(stored.relevance, "out_of_scope");
  });
});

describe("recomputeRelevanceForRow — optimistic concurrency guard", () => {
  it("does not overwrite a row a concurrent recompute already stamped with a different version", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const db: RecomputeRelevanceDb = {
      competitorIntelligence: {
        updateMany: async ({ where }) => {
          writes.push(where);
          // Simulate: the row's ACTUAL stored relevanceProfileVersion is now 2,
          // but this call still expects the OLD value (null) — the guard fails.
          return { count: 0 };
        },
      },
      competitor: { findFirst: async () => ({ archivedAt: null }) },
    };
    const outcome = await recomputeRelevanceForRow(
      row({ relevanceProfileVersion: null }),
      PROFILE,
      3,
      {
        db,
        resolveProvider: okProvider("home insulation"),
      }
    );
    assert.deepEqual(outcome, { status: "skipped", reason: "claimed" });
  });
});

describe("recomputeRelevanceForRow — no provider", () => {
  it("returns no_provider without writing anything", async () => {
    const { db, writes } = makeFakeDb(null);
    const outcome = await recomputeRelevanceForRow(row(), PROFILE, 1, {
      db,
      resolveProvider: async () => ({ ok: false }),
    });
    assert.deepEqual(outcome, { status: "no_provider" });
    assert.equal(writes.length, 0);
  });
});

describe("staleWhere", () => {
  it("matches rows with a null version or a version different from current", () => {
    const where = staleWhere("co-1", 5);
    assert.deepEqual(where.OR, [
      { relevanceProfileVersion: null },
      { relevanceProfileVersion: { not: 5 } },
    ]);
  });
});

describe("recomputeStaleRelevanceForCompany — the §2 drain-race fix", () => {
  it("re-reads the CURRENT profile version for `remaining`, not the version this run started with", async () => {
    // Reproduces the exact race: this run starts against version 4 (what
    // loadProfile returns), but by the time it finishes, a second Save has
    // already landed at version 5 (what currentProfileVersion now returns).
    const summary = await recomputeStaleRelevanceForCompany("co-1", {
      loadProfile: async () => ({ researchTopics: ["x"], markets: [], profileVersion: 4 }),
      findStaleRows: async () => [],
      currentProfileVersion: async () => 5,
      countRemaining: async (_companyId, version) => {
        // Only returns a nonzero count when asked about the LIVE version (5),
        // not the stale one (4) — proving the drain queries with the fresh
        // value, not the one it started with.
        return version === 5 ? 7 : 0;
      },
    });
    assert.equal(summary.remaining, 7);
  });

  it("falls back to the run's own version when currentProfileVersion cannot resolve one", async () => {
    const summary = await recomputeStaleRelevanceForCompany("co-1", {
      loadProfile: async () => ({ researchTopics: ["x"], markets: [], profileVersion: 4 }),
      findStaleRows: async () => [],
      currentProfileVersion: async () => null,
      countRemaining: async (_companyId, version) => (version === 4 ? 3 : 0),
    });
    assert.equal(summary.remaining, 3);
  });
});

describe("recomputeStaleRelevanceForCompany — no persisted profile", () => {
  it("does nothing when no CompetitorResearchProfile row exists for the company", async () => {
    const summary = await recomputeStaleRelevanceForCompany("co-1", {
      loadProfile: async () => null,
    });
    assert.deepEqual(summary, {
      companyId: "co-1",
      processed: 0,
      updated: 0,
      failed: 0,
      skipped: 0,
      remaining: 0,
    });
  });
});

describe("recomputeStaleRelevanceForCompany — batch processing", () => {
  it("processes every stale row via recomputeRelevanceForRow and tallies outcomes", async () => {
    const { db } = makeFakeDb(null);
    const summary = await recomputeStaleRelevanceForCompany("co-1", {
      loadProfile: async () => ({
        researchTopics: ["home insulation"],
        markets: [],
        profileVersion: 1,
      }),
      findStaleRows: async () => [row({ id: "a" }), row({ id: "b" })],
      currentProfileVersion: async () => 1,
      countRemaining: async () => 0,
      db,
      resolveProvider: okProvider("home insulation"),
    });
    assert.equal(summary.processed, 2);
    assert.equal(summary.updated, 2);
  });

  it("stops the batch (without failing it) once no provider is configured", async () => {
    let rowsAttempted = 0;
    const { db } = makeFakeDb(null);
    const summary = await recomputeStaleRelevanceForCompany("co-1", {
      loadProfile: async () => ({
        researchTopics: ["home insulation"],
        markets: [],
        profileVersion: 1,
      }),
      findStaleRows: async () => [row({ id: "a" }), row({ id: "b" }), row({ id: "c" })],
      currentProfileVersion: async () => 1,
      countRemaining: async () => 3,
      db,
      resolveProvider: async () => {
        rowsAttempted++;
        return { ok: false };
      },
    });
    // Only the FIRST row triggers a provider resolution attempt before the
    // batch stops — the remaining two are left for the next run.
    assert.equal(rowsAttempted, 1);
    assert.equal(summary.remaining, 3);
  });
});
