import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runCompetitorIntelligenceExtraction,
  selectableWhere,
  deferredWhere,
  type RemainingCounts,
} from "./run-competitor-intelligence-extraction.service";
import {
  extractCompetitorIntelligence,
  type ExtractableIntelligenceItem,
  type ExtractCompetitorIntelligenceDb,
} from "./extract-competitor-intelligence.service";
import { MAX_EXTRACTION_ATTEMPTS } from "@/lib/ai/competitor-intelligence-extraction";

function item(id: string): ExtractableIntelligenceItem {
  return {
    id,
    competitorId: "c-1",
    status: "pending",
    attemptCount: 0,
    feedItem: { title: "T", content: "Body" },
    manualEntry: null,
  };
}

const noRemaining: RemainingCounts = { ready: 0, deferred: 0 };

describe("runCompetitorIntelligenceExtraction", () => {
  it("processes every candidate found and tallies outcomes", async () => {
    const items = [item("a"), item("b"), item("c")];
    const summary = await runCompetitorIntelligenceExtraction({
      findCandidates: async () => items,
      countRemaining: async () => noRemaining,
      extract: async (it) =>
        it.id === "b" ? { status: "failed", error: "boom" } : { status: "extracted" },
    });
    assert.equal(summary.processed, 3);
    assert.equal(summary.extracted, 2);
    assert.equal(summary.failed, 1);
    assert.equal(summary.skipped, 0);
    assert.equal(summary.remainingReady, 0);
    assert.equal(summary.remainingDeferred, 0);
  });

  it("counts every non-extracted, non-failed outcome as skipped, bucketed by reason", async () => {
    const summary = await runCompetitorIntelligenceExtraction({
      findCandidates: async () => [item("a"), item("b")],
      countRemaining: async () => noRemaining,
      extract: async () => ({ status: "skipped", reason: "archived" }),
    });
    assert.equal(summary.skipped, 2);
    assert.equal(summary.extracted, 0);
    assert.equal(summary.failed, 0);
    assert.deepEqual(summary.skippedByReason, { archived: 2 });
  });

  it("buckets the no_provider outcome (a distinct top-level status) under its own skippedByReason key", async () => {
    const summary = await runCompetitorIntelligenceExtraction({
      findCandidates: async () => [item("a")],
      countRemaining: async () => noRemaining,
      extract: async () => ({ status: "no_provider" }),
    });
    assert.deepEqual(summary.skippedByReason, { no_provider: 1 });
  });

  it("reports remainingReady/remainingDeferred from the injected counter, independent of what was processed", async () => {
    const summary = await runCompetitorIntelligenceExtraction({
      findCandidates: async () => [item("a")],
      countRemaining: async () => ({ ready: 41, deferred: 1 }),
      extract: async () => ({ status: "extracted" }),
    });
    assert.equal(summary.remainingReady, 41);
    assert.equal(summary.remainingDeferred, 1);
  });

  it("does nothing and reports zero processed when there are no candidates", async () => {
    let extractCalls = 0;
    const summary = await runCompetitorIntelligenceExtraction({
      findCandidates: async () => [],
      countRemaining: async () => noRemaining,
      extract: async () => {
        extractCalls++;
        return { status: "extracted" };
      },
    });
    assert.equal(summary.processed, 0);
    assert.equal(extractCalls, 0);
  });

  it("caps the candidate request at the extraction batch size", async () => {
    let requestedLimit: number | undefined;
    await runCompetitorIntelligenceExtraction({
      findCandidates: async (limit) => {
        requestedLimit = limit;
        return [];
      },
      countRemaining: async () => noRemaining,
    });
    assert.ok(requestedLimit && requestedLimit > 0);
  });
});

// ─── 2026-09 production livelock fix — progress tracking ──────────────────
// See run-competitor-intelligence-extraction.service.ts's module comment for
// the incident. `progressed` is the drain-level half of the no-progress
// continuation guard; the handler-level half is covered in
// competitor-intelligence-extraction-handler.test.ts.

describe("runCompetitorIntelligenceExtraction — progressed", () => {
  it("is true when at least one item is extracted", async () => {
    const summary = await runCompetitorIntelligenceExtraction({
      findCandidates: async () => [item("a")],
      countRemaining: async () => noRemaining,
      extract: async () => ({ status: "extracted" }),
    });
    assert.equal(summary.progressed, true);
  });

  it("is true when at least one item fails with a real error", async () => {
    const summary = await runCompetitorIntelligenceExtraction({
      findCandidates: async () => [item("a")],
      countRemaining: async () => noRemaining,
      extract: async () => ({ status: "failed", error: "boom" }),
    });
    assert.equal(summary.progressed, true);
  });

  it("is true for a terminal skip that consumes attempt budget (archived / missing_origin / missing_content)", async () => {
    for (const reason of ["archived", "missing_origin", "missing_content"] as const) {
      const summary = await runCompetitorIntelligenceExtraction({
        findCandidates: async () => [item("a")],
        countRemaining: async () => noRemaining,
        extract: async () => ({ status: "skipped", reason }),
      });
      assert.equal(summary.progressed, true, `expected progressed=true for reason "${reason}"`);
    }
  });

  it("is FALSE when the entire batch is contended claims — the exact no-op that must not hot-loop", async () => {
    const summary = await runCompetitorIntelligenceExtraction({
      findCandidates: async () => [item("a"), item("b"), item("c")],
      countRemaining: async () => ({ ready: 3, deferred: 0 }),
      extract: async () => ({ status: "skipped", reason: "claimed" }),
    });
    assert.equal(summary.progressed, false);
  });

  it("is FALSE when the entire batch skips for lack of a configured provider", async () => {
    const summary = await runCompetitorIntelligenceExtraction({
      findCandidates: async () => [item("a")],
      countRemaining: async () => ({ ready: 1, deferred: 0 }),
      extract: async () => ({ status: "no_provider" }),
    });
    assert.equal(summary.progressed, false);
  });

  it("is FALSE when the batch is entirely defensive max_attempts skips", async () => {
    const summary = await runCompetitorIntelligenceExtraction({
      findCandidates: async () => [item("a")],
      countRemaining: async () => ({ ready: 0, deferred: 0 }),
      extract: async () => ({ status: "skipped", reason: "max_attempts" }),
    });
    assert.equal(summary.progressed, false);
  });

  it("is FALSE when there is nothing to process at all", async () => {
    const summary = await runCompetitorIntelligenceExtraction({
      findCandidates: async () => [],
      countRemaining: async () => noRemaining,
    });
    assert.equal(summary.progressed, false);
  });
});

// ─── §7 verification-pass fix: crashed-run lease reclaim ──────────────────
// A row stuck at `analyzing` with an expired lease must remain selectable —
// see this function's own doc comment for the exact bug this closes.

interface Row {
  id: string;
  status: string;
  attemptCount: number;
  leaseExpiresAt: Date | null;
  competitorArchivedAt: Date | null;
}

/** Interprets `selectableWhere`'s output against a row — the same
 *  "interpret the where, don't just inspect its shape" discipline
 *  `build-generation-context.service.test.ts` uses, for the same reason: a
 *  well-formed clause that matches nothing passes a shape assertion happily. */
function matches(row: Row, where: Record<string, unknown>): boolean {
  if ((where.attemptCount as { lt: number }).lt <= row.attemptCount) return false;
  if ((where.competitor as { archivedAt: null }).archivedAt !== row.competitorArchivedAt)
    return false;
  const or = where.OR as Array<Record<string, unknown>>;
  const pendingFailed =
    "status" in or[0] && (or[0].status as { in: string[] }).in.includes(row.status);
  const expiredLease =
    row.status === (or[1].status as string) &&
    row.leaseExpiresAt !== null &&
    row.leaseExpiresAt.getTime() < (or[1].leaseExpiresAt as { lt: Date }).lt.getTime();
  return pendingFailed || expiredLease;
}

/** Interprets `deferredWhere`'s output against a row, the same discipline. */
function matchesDeferred(row: Row, where: Record<string, unknown>): boolean {
  if ((where.attemptCount as { lt: number }).lt <= row.attemptCount) return false;
  if ((where.competitor as { archivedAt: null }).archivedAt !== row.competitorArchivedAt)
    return false;
  if (where.status !== row.status) return false;
  if (row.leaseExpiresAt === null) return false;
  return row.leaseExpiresAt.getTime() >= (where.leaseExpiresAt as { gte: Date }).gte.getTime();
}

describe("selectableWhere — crashed-run reclaim (§7 verification-pass fix)", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  const base = { attemptCount: 0, competitorArchivedAt: null };

  it("matches a pending row", () => {
    const row: Row = { id: "a", status: "pending", leaseExpiresAt: null, ...base };
    assert.equal(matches(row, selectableWhere(now)), true);
  });

  it("matches a failed row", () => {
    const row: Row = { id: "a", status: "failed", leaseExpiresAt: null, ...base };
    assert.equal(matches(row, selectableWhere(now)), true);
  });

  it("matches an `analyzing` row whose lease has EXPIRED — the crashed-run case", () => {
    const row: Row = {
      id: "a",
      status: "analyzing",
      leaseExpiresAt: new Date(now.getTime() - 60_000),
      ...base,
    };
    assert.equal(matches(row, selectableWhere(now)), true);
  });

  it("does NOT match an `analyzing` row whose lease is still LIVE — a run currently in flight", () => {
    const row: Row = {
      id: "a",
      status: "analyzing",
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      ...base,
    };
    assert.equal(matches(row, selectableWhere(now)), false);
  });

  it("excludes a row past the attempt cap regardless of status", () => {
    const row: Row = {
      id: "a",
      status: "pending",
      leaseExpiresAt: null,
      attemptCount: 3,
      competitorArchivedAt: null,
    };
    assert.equal(matches(row, selectableWhere(now)), false);
  });

  it("excludes a row whose competitor is archived", () => {
    const row: Row = {
      id: "a",
      status: "pending",
      leaseExpiresAt: null,
      attemptCount: 0,
      competitorArchivedAt: new Date(),
    };
    assert.equal(matches(row, selectableWhere(now)), false);
  });
});

describe("deferredWhere — 2026-09 livelock fix, the ready/deferred split", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  const base = { attemptCount: 0, competitorArchivedAt: null };

  it("matches an `analyzing` row whose lease is still LIVE — genuinely not processable yet", () => {
    const row: Row = {
      id: "a",
      status: "analyzing",
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      ...base,
    };
    assert.equal(matchesDeferred(row, deferredWhere(now)), true);
    // The two predicates are mutually exclusive by construction — a row is
    // never double-counted across remainingReady and remainingDeferred.
    assert.equal(matches(row, selectableWhere(now)), false);
  });

  it("does NOT match a row whose lease has expired — that row is ready, not deferred", () => {
    const row: Row = {
      id: "a",
      status: "analyzing",
      leaseExpiresAt: new Date(now.getTime() - 60_000),
      ...base,
    };
    assert.equal(matchesDeferred(row, deferredWhere(now)), false);
  });

  it("does NOT match a pending/failed row — those are ready, not deferred", () => {
    for (const status of ["pending", "failed"]) {
      const row: Row = { id: "a", status, leaseExpiresAt: null, ...base };
      assert.equal(matchesDeferred(row, deferredWhere(now)), false);
    }
  });

  it("does NOT count a row past the attempt cap as deferred — it is permanently ineligible, not waiting", () => {
    const row: Row = {
      id: "a",
      status: "analyzing",
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      attemptCount: MAX_EXTRACTION_ATTEMPTS,
      competitorArchivedAt: null,
    };
    assert.equal(matchesDeferred(row, deferredWhere(now)), false);
  });

  it("does NOT count an archived competitor's row as deferred", () => {
    const row: Row = {
      id: "a",
      status: "analyzing",
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      attemptCount: 0,
      competitorArchivedAt: new Date(),
    };
    assert.equal(matchesDeferred(row, deferredWhere(now)), false);
  });
});

// ─── 2026-09 production livelock — end-to-end regression, real row shape ──
// Reproduces the EXACT state found in the affected production rows (10/10):
// status "failed", attemptCount 0, a loaded FeedItem whose `content` is
// null, competitor not archived — and drives the REAL `extractCompetitorIntelligence`
// (not a stub) through repeated drain runs, proving the fix terminates in
// MAX_EXTRACTION_ATTEMPTS runs instead of looping forever.

interface LiveRow {
  id: string;
  status: string;
  attemptCount: number;
  leaseExpiresAt: Date | null;
  analysisError: string | null;
  competitorArchivedAt: Date | null;
}

function makeLiveFakeDb(row: LiveRow): ExtractCompetitorIntelligenceDb {
  return {
    competitorIntelligence: {
      updateMany: async ({ where, data }) => {
        const w = where as { id: string; status?: string; leaseExpiresAt?: Date };
        if (w.id !== row.id) return { count: 0 };
        if (w.status !== undefined && row.status !== w.status) return { count: 0 };
        if (
          w.leaseExpiresAt !== undefined &&
          row.leaseExpiresAt?.getTime() !== w.leaseExpiresAt.getTime()
        ) {
          return { count: 0 };
        }
        if (w.status === undefined && "OR" in where) {
          const or = (where as { OR: Array<Record<string, unknown>> }).OR;
          const matchesPendingFailed =
            "status" in or[0] && (or[0].status as { in: string[] }).in.includes(row.status);
          const matchesExpiredLease =
            or[1] &&
            row.status === "analyzing" &&
            row.leaseExpiresAt !== null &&
            row.leaseExpiresAt.getTime() < (or[1].leaseExpiresAt as { lt: Date }).lt.getTime();
          if (!matchesPendingFailed && !matchesExpiredLease) return { count: 0 };
        }
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    competitor: {
      findFirst: async () => ({ archivedAt: row.competitorArchivedAt }),
    },
  };
}

describe("2026-09 production livelock — real row shape, end to end", () => {
  it("a row with a loaded FeedItem but null content terminates after MAX_EXTRACTION_ATTEMPTS runs, never looping forever", async () => {
    // Exact shape confirmed against the real database: status "failed",
    // attemptCount 0, feedItem present with content: null, competitor active.
    const row: LiveRow = {
      id: "ci-1",
      status: "failed",
      attemptCount: 0,
      leaseExpiresAt: null,
      analysisError: "No readable content to analyze.",
      competitorArchivedAt: null,
    };
    const db = makeLiveFakeDb(row);
    const fixedNow = new Date("2026-09-01T12:00:00Z");

    const extractableItem: ExtractableIntelligenceItem = {
      id: row.id,
      competitorId: "c-1",
      status: row.status,
      attemptCount: row.attemptCount,
      feedItem: { title: "Some article", content: null },
      manualEntry: null,
    };

    function isReady(): boolean {
      if (row.attemptCount >= MAX_EXTRACTION_ATTEMPTS) return false;
      if (row.competitorArchivedAt !== null) return false;
      if (row.status === "pending" || row.status === "failed") return true;
      return (
        row.status === "analyzing" &&
        row.leaseExpiresAt !== null &&
        row.leaseExpiresAt.getTime() < fixedNow.getTime()
      );
    }

    // A dummy provider — never actually reached (content is null, so the
    // missing-content check bails before the model-call loop), but needed
    // because provider resolution happens before that check and must not
    // fall through to the real, DB-backed default in a unit test.
    const stubProvider = async () =>
      ({
        ok: true as const,
        instance: { generate: async () => ({ text: "{}" }) },
        provider: "test",
        model: "test-model",
      }) as const;

    const runOnce = () =>
      runCompetitorIntelligenceExtraction({
        findCandidates: async () =>
          isReady()
            ? [{ ...extractableItem, attemptCount: row.attemptCount, status: row.status }]
            : [],
        countRemaining: async () => ({ ready: isReady() ? 1 : 0, deferred: 0 }),
        extract: (it) =>
          extractCompetitorIntelligence(it, {
            db,
            now: () => fixedNow,
            resolveProvider: stubProvider,
          }),
      });

    // Runs 1..MAX_EXTRACTION_ATTEMPTS: the row is genuinely reprocessed and
    // genuinely makes progress each time (attemptCount advances) — this is
    // bounded RETRY behavior, not a hot loop.
    for (let run = 1; run <= MAX_EXTRACTION_ATTEMPTS; run++) {
      const summary = await runOnce();
      assert.equal(summary.processed, 1, `run ${run}: expected the row to be processed`);
      assert.equal(summary.skipped, 1, `run ${run}: expected a skip (no usable content)`);
      assert.deepEqual(summary.skippedByReason, { missing_content: 1 }, `run ${run}`);
      assert.equal(summary.progressed, true, `run ${run}: attemptCount must have advanced`);
      assert.equal(row.attemptCount, run, `run ${run}: attemptCount should now equal ${run}`);
    }

    // After MAX_EXTRACTION_ATTEMPTS, the row is permanently excluded — this
    // is the exact number that used to be "remaining: 10" forever.
    assert.equal(row.attemptCount, MAX_EXTRACTION_ATTEMPTS);
    assert.equal(isReady(), false);

    // One more run: nothing left to process, nothing left "remaining" — the
    // drain is quiescent, not hot-looping.
    const finalSummary = await runOnce();
    assert.equal(finalSummary.processed, 0);
    assert.equal(finalSummary.remainingReady, 0);
    assert.equal(finalSummary.progressed, false);
  });

  it("an archived-competitor release restores attemptCount — no scar left behind by the release itself", async () => {
    const row: LiveRow = {
      id: "ci-1",
      status: "pending",
      attemptCount: 1,
      leaseExpiresAt: null,
      analysisError: null,
      competitorArchivedAt: new Date(), // already archived at claim time
    };
    const db = makeLiveFakeDb(row);
    const item: ExtractableIntelligenceItem = {
      id: row.id,
      competitorId: "c-1",
      status: row.status,
      attemptCount: row.attemptCount,
      feedItem: { title: "T", content: "Body" },
      manualEntry: null,
    };

    const stubProvider = async () =>
      ({
        ok: true as const,
        instance: { generate: async () => ({ text: "{}" }) },
        provider: "test",
        model: "test-model",
      }) as const;
    const outcome = await extractCompetitorIntelligence(item, {
      db,
      resolveProvider: stubProvider,
    });
    assert.deepEqual(outcome, { status: "skipped", reason: "archived" });
    // Restored to its pre-claim value (1), not left at the claim's
    // incremented value (2) — the scar this release is supposed to prevent.
    assert.equal(row.attemptCount, 1);
    assert.equal(row.status, "pending");
  });
});
