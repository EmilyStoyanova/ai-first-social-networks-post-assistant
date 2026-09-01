import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  recomputeRelevanceForRow,
  recomputeStaleRelevanceForCompany,
  staleWhere,
  type RecomputeRelevanceDb,
  type RelevanceRow,
} from "./recompute-stale-relevance.service";
import { MAX_RELEVANCE_ATTEMPTS, type RelevanceProfile } from "@/lib/ai/competitor-relevance";
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
    relevanceAttemptCount: 0,
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

function makeFakeDb(archivedAt: Date | null = null, initialVersion: number | null = null) {
  const writes: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  // Per-ROW version state, keyed by id — a single shared variable here would
  // make row B's write incorrectly guard against row A's just-written
  // version, which is not how the real optimistic-concurrency check works
  // (it is scoped per row via `relevanceProfileVersion` in the WHERE).
  // `initialVersion` seeds what a row's FIRST call sees as "already
  // persisted" — most tests want the default (null, matching a brand-new
  // row), but the 2026-09 relevance-retry fix's tests need to simulate a row
  // that already sits at a prior version (e.g. exhausted its retries once
  // already) without replaying every call that got it there.
  const versionByRow = new Map<string, number | null>();
  const stored: Record<string, unknown> = {};
  const db: RecomputeRelevanceDb = {
    competitorIntelligence: {
      updateMany: async ({ where, data }) => {
        writes.push({ where, data });
        const w = where as { id: string; relevanceProfileVersion: number | null };
        const current = versionByRow.has(w.id) ? versionByRow.get(w.id)! : initialVersion;
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
      progressed: false,
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

// ─── 2026-09 relevance-retry fix ───────────────────────────────────────────
// See recompute-stale-relevance.service.ts's module comment for the incident:
// a permanently-failing row wrote nothing on failure, so it was reselected
// and reattempted forever, with no progress guard on the handler's
// continuation — the relevance-drain analogue of the extraction livelock
// this session already fixed once, for the identical structural reason.

function failProvider() {
  return async () => ({
    ok: true as const,
    instance: {
      generate: async () => {
        throw new Error("provider exploded");
      },
    } as ILlmProvider,
    provider: "test",
    model: "test-model",
  });
}

describe("recomputeRelevanceForRow — bounded retry (2026-09 relevance-retry fix)", () => {
  it("a real model failure writes attemptCount and the error, WITHOUT touching relevanceProfileVersion", async () => {
    const { db, stored } = makeFakeDb(null);
    const outcome = await recomputeRelevanceForRow(
      row({ relevanceProfileVersion: null, relevanceAttemptCount: 0 }),
      PROFILE,
      1,
      { db, resolveProvider: failProvider() }
    );
    assert.deepEqual(outcome, { status: "failed" });
    assert.equal(stored.relevanceAttemptCount, 1);
    assert.equal(stored.relevanceReason, "provider exploded");
    // Deliberately absent from this write — a failed attempt must remain
    // retryable, i.e. still match `staleWhere` on the next run.
    assert.equal("relevanceProfileVersion" in stored, false);
  });

  it("accumulates attempts across repeated failures against the SAME version", async () => {
    const { db, stored } = makeFakeDb(null);
    let current = row({ relevanceProfileVersion: null, relevanceAttemptCount: 0 });
    for (let i = 1; i <= 2; i++) {
      const outcome = await recomputeRelevanceForRow(current, PROFILE, 1, {
        db,
        resolveProvider: failProvider(),
      });
      assert.deepEqual(outcome, { status: "failed" });
      assert.equal(stored.relevanceAttemptCount, i);
      current = row({
        relevanceProfileVersion: null,
        relevanceAttemptCount: stored.relevanceAttemptCount as number,
      });
    }
  });

  it("settles the row WITHOUT a model call once MAX_RELEVANCE_ATTEMPTS is reached — the hot-loop stop", async () => {
    let modelCalled = false;
    // Seeded at version 1 — simulates a row that already sits at
    // relevanceAttemptCount: 3 against version 1 (reached via prior calls
    // this test doesn't need to replay).
    const { db, stored } = makeFakeDb(null, 1);
    const outcome = await recomputeRelevanceForRow(
      // Already at the cap, evaluated against THIS SAME version (1) — the
      // exact shape a permanently-failing row reaches after repeated runs.
      row({ relevanceProfileVersion: 1, relevanceAttemptCount: 3 }),
      PROFILE,
      1,
      {
        db,
        resolveProvider: async () => {
          modelCalled = true;
          return failProvider()();
        },
      }
    );
    assert.deepEqual(outcome, { status: "skipped", reason: "max_attempts" });
    assert.equal(modelCalled, false, "no model call — this is what stops the hot loop");
    // Settled: version stamped (leaves staleWhere), reason explains why, NOT
    // silently left "pending" with nothing to show — see the module comment.
    assert.equal(stored.relevanceProfileVersion, 1);
    assert.ok((stored.relevanceReason as string).includes("failed after 3 attempts"));
    assert.equal(stored.relevanceAttemptCount, 0);
  });

  it("a NEW profile version resets the retry budget — a row exhausted under an OLD version gets a fresh chance", async () => {
    const { db, stored } = makeFakeDb(null, 1);
    // Exhausted against version 1 (relevanceAttemptCount: 3), but this call
    // targets version 2 — a genuine profile change since the last exhaustion.
    const outcome = await recomputeRelevanceForRow(
      row({ relevanceProfileVersion: 1, relevanceAttemptCount: 3 }),
      PROFILE,
      2,
      { db, resolveProvider: okProvider("home insulation") }
    );
    assert.deepEqual(outcome, { status: "updated" });
    assert.equal(stored.relevance, "relevant");
    assert.equal(stored.relevanceProfileVersion, 2);
  });

  it("a successful evaluation resets relevanceAttemptCount to 0", async () => {
    const { db, stored } = makeFakeDb(null);
    await recomputeRelevanceForRow(
      row({ relevanceProfileVersion: null, relevanceAttemptCount: 2 }),
      PROFILE,
      1,
      { db, resolveProvider: okProvider("home insulation") }
    );
    assert.equal(stored.relevanceAttemptCount, 0);
  });
});

describe("relevanceEvaluatedAt — set only on a genuine verdict (2026-09 relevance-retry fix)", () => {
  it("is stamped on a successful relevant/not-relevant verdict", async () => {
    const { db, stored } = makeFakeDb(null);
    await recomputeRelevanceForRow(row(), PROFILE, 1, {
      db,
      resolveProvider: okProvider("home insulation"),
    });
    assert.ok(stored.relevanceEvaluatedAt instanceof Date);
  });

  it("is stamped on the deterministic out_of_scope verdict (no research interests configured)", async () => {
    const { db, stored } = makeFakeDb(null);
    await recomputeRelevanceForRow(row(), EMPTY_PROFILE, 1, { db });
    assert.ok(stored.relevanceEvaluatedAt instanceof Date);
  });

  it("is NEVER stamped on a failed model call", async () => {
    const { db, stored } = makeFakeDb(null);
    await recomputeRelevanceForRow(row({ relevanceAttemptCount: 0 }), PROFILE, 1, {
      db,
      resolveProvider: failProvider(),
    });
    assert.equal("relevanceEvaluatedAt" in stored, false);
  });

  it("is NEVER stamped on an exhausted-retries settle (max_attempts)", async () => {
    const { db, stored } = makeFakeDb(null, 1);
    await recomputeRelevanceForRow(
      row({ relevanceProfileVersion: 1, relevanceAttemptCount: 3 }),
      PROFILE,
      1,
      { db, resolveProvider: failProvider() }
    );
    assert.equal("relevanceEvaluatedAt" in stored, false);
  });
});

describe("recomputeStaleRelevanceForCompany — progressed (2026-09 relevance-retry fix)", () => {
  it("is true when at least one row updates", async () => {
    const { db } = makeFakeDb(null);
    const summary = await recomputeStaleRelevanceForCompany("co-1", {
      loadProfile: async () => ({
        researchTopics: ["home insulation"],
        markets: [],
        profileVersion: 1,
      }),
      findStaleRows: async () => [row({ id: "a" })],
      currentProfileVersion: async () => 1,
      countRemaining: async () => 0,
      db,
      resolveProvider: okProvider("home insulation"),
    });
    assert.equal(summary.progressed, true);
  });

  it("is true when a row fails with a real error (the failure itself writes attempt state)", async () => {
    const { db } = makeFakeDb(null);
    const summary = await recomputeStaleRelevanceForCompany("co-1", {
      loadProfile: async () => ({
        researchTopics: ["home insulation"],
        markets: [],
        profileVersion: 1,
      }),
      findStaleRows: async () => [row({ id: "a", relevanceAttemptCount: 0 })],
      currentProfileVersion: async () => 1,
      countRemaining: async () => 1,
      db,
      resolveProvider: failProvider(),
    });
    assert.equal(summary.progressed, true);
  });

  it("is true when a row settles at max_attempts", async () => {
    const { db } = makeFakeDb(null, 1);
    const summary = await recomputeStaleRelevanceForCompany("co-1", {
      loadProfile: async () => ({
        researchTopics: ["home insulation"],
        markets: [],
        profileVersion: 1,
      }),
      findStaleRows: async () => [
        row({ id: "a", relevanceProfileVersion: 1, relevanceAttemptCount: 3 }),
      ],
      currentProfileVersion: async () => 1,
      countRemaining: async () => 0,
      db,
      resolveProvider: failProvider(),
    });
    assert.equal(summary.progressed, true);
  });

  it("is FALSE when the entire batch is contended claims — the exact no-op that must not hot-loop", async () => {
    const writes: unknown[] = [];
    const db: RecomputeRelevanceDb = {
      competitorIntelligence: { updateMany: async () => ({ count: 0 }) },
      competitor: { findFirst: async () => ({ archivedAt: null }) },
    };
    const summary = await recomputeStaleRelevanceForCompany("co-1", {
      loadProfile: async () => ({
        researchTopics: ["home insulation"],
        markets: [],
        profileVersion: 1,
      }),
      findStaleRows: async () => [row({ id: "a" }), row({ id: "b" })],
      currentProfileVersion: async () => 1,
      countRemaining: async () => 2,
      db,
      resolveProvider: okProvider("home insulation"),
    });
    assert.equal(writes.length, 0);
    assert.equal(summary.progressed, false);
  });

  it("is FALSE when every row is archived — this run genuinely changed nothing", async () => {
    const { db } = makeFakeDb(new Date());
    const summary = await recomputeStaleRelevanceForCompany("co-1", {
      loadProfile: async () => ({
        researchTopics: ["home insulation"],
        markets: [],
        profileVersion: 1,
      }),
      findStaleRows: async () => [row({ id: "a" }), row({ id: "b" })],
      currentProfileVersion: async () => 1,
      countRemaining: async () => 2,
      db,
      resolveProvider: okProvider("home insulation"),
    });
    assert.equal(summary.progressed, false);
  });

  // The end-to-end proof this section exists for: a permanently-failing row,
  // repeated across enough runs to exhaust its retry budget, terminates —
  // NOT the extraction-livelock shape (`processed: N, successful: 0,
  // remaining: N forever`). Once settled, a further run finds nothing stale
  // for it and reports zero progress (quiescent).
  it("a permanently-failing row terminates after MAX_RELEVANCE_ATTEMPTS runs — never loops forever", async () => {
    const { db, stored } = makeFakeDb(null);
    const loadProfile = async () => ({
      researchTopics: ["home insulation"],
      markets: [],
      profileVersion: 1,
    });
    let attemptCount = 0;
    let profileVersion: number | null = null;
    let settled = false;

    const runOnce = () =>
      recomputeStaleRelevanceForCompany("co-1", {
        loadProfile,
        findStaleRows: async () =>
          settled
            ? [] // stamped at the current version — no longer stale
            : [
                row({
                  id: "ci-1",
                  relevanceProfileVersion: profileVersion,
                  relevanceAttemptCount: attemptCount,
                }),
              ],
        currentProfileVersion: async () => 1,
        countRemaining: async () => (settled ? 0 : 1),
        db,
        resolveProvider: failProvider(),
      });

    // Three failing attempts — each one genuinely writes (attempt count +
    // error), consuming budget, never settling the row yet.
    for (let run = 1; run <= MAX_RELEVANCE_ATTEMPTS; run++) {
      const summary = await runOnce();
      assert.equal(summary.processed, 1, `run ${run}`);
      assert.equal(summary.progressed, true, `run ${run}: attempt must have advanced`);
      attemptCount = stored.relevanceAttemptCount as number;
      assert.equal(attemptCount, run, `run ${run}: attempt count should now equal ${run}`);
    }

    // The NEXT run finds `priorAttempts >= MAX_RELEVANCE_ATTEMPTS` and
    // settles WITHOUT a model call: version stamped, reason explains why —
    // this is the exact write that stops the hot loop.
    const settlingRun = await runOnce();
    assert.equal(settlingRun.processed, 1);
    assert.equal(settlingRun.progressed, true);
    profileVersion = (stored.relevanceProfileVersion as number | null) ?? null;
    assert.equal(profileVersion, 1);
    assert.equal(stored.relevanceAttemptCount, 0);
    settled = true;

    // One more run: nothing left to process, nothing left "remaining" — the
    // drain is quiescent, not hot-looping.
    const finalSummary = await runOnce();
    assert.equal(finalSummary.processed, 0);
    assert.equal(finalSummary.remaining, 0);
    assert.equal(finalSummary.progressed, false, "quiescent — not hot-looping");
  });
});
