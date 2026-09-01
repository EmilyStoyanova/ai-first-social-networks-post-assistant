import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runCompetitorIntelligenceExtraction,
  selectableWhere,
} from "./run-competitor-intelligence-extraction.service";
import type { ExtractableIntelligenceItem } from "./extract-competitor-intelligence.service";

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

describe("runCompetitorIntelligenceExtraction", () => {
  it("processes every candidate found and tallies outcomes", async () => {
    const items = [item("a"), item("b"), item("c")];
    const summary = await runCompetitorIntelligenceExtraction({
      findCandidates: async () => items,
      countRemaining: async () => 0,
      extract: async (it) =>
        it.id === "b" ? { status: "failed", error: "boom" } : { status: "extracted" },
    });
    assert.equal(summary.processed, 3);
    assert.equal(summary.extracted, 2);
    assert.equal(summary.failed, 1);
    assert.equal(summary.skipped, 0);
    assert.equal(summary.remaining, 0);
  });

  it("counts every non-extracted, non-failed outcome as skipped", async () => {
    const summary = await runCompetitorIntelligenceExtraction({
      findCandidates: async () => [item("a"), item("b")],
      countRemaining: async () => 0,
      extract: async () => ({ status: "skipped", reason: "archived" }),
    });
    assert.equal(summary.skipped, 2);
    assert.equal(summary.extracted, 0);
    assert.equal(summary.failed, 0);
  });

  it("reports remaining from the injected counter, independent of what was processed", async () => {
    const summary = await runCompetitorIntelligenceExtraction({
      findCandidates: async () => [item("a")],
      countRemaining: async () => 42,
      extract: async () => ({ status: "extracted" }),
    });
    assert.equal(summary.remaining, 42);
  });

  it("does nothing and reports zero processed when there are no candidates", async () => {
    let extractCalls = 0;
    const summary = await runCompetitorIntelligenceExtraction({
      findCandidates: async () => [],
      countRemaining: async () => 0,
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
      countRemaining: async () => 0,
    });
    assert.ok(requestedLimit && requestedLimit > 0);
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
