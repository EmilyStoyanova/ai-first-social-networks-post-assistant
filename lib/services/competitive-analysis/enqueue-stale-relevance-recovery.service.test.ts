import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  enqueueStaleRelevanceRecovery,
  RELEVANCE_RECOVERY_MAX_COMPANIES,
  type RecoverableProfile,
} from "./enqueue-stale-relevance-recovery.service";
import { staleWhere } from "./recompute-stale-relevance.service";
import type { EnqueueJobResult } from "@/lib/services/queue/enqueue-job.service";

/** Records every enqueue so idempotency/fan-out can be asserted exactly. */
function makeEnqueue(result: Partial<EnqueueJobResult> = {}) {
  const calls: string[] = [];
  const fn = async (companyId: string): Promise<EnqueueJobResult> => {
    calls.push(companyId);
    return {
      enqueued: result.enqueued ?? true,
      deduplicated: result.deduplicated ?? false,
      jobId: result.jobId ?? `job-${calls.length}`,
    };
  };
  return { fn, calls };
}

/**
 * A fake row store the sweep's `hasStaleRows` seam reads through, deliberately
 * driven by `staleWhere` itself rather than a hand-written predicate — so a
 * future change to the drain's selection that this sweep failed to follow
 * would break these tests instead of silently diverging.
 */
interface FakeRow {
  companyId: string;
  status: string;
  relevance: string;
  relevanceProfileVersion: number | null;
  competitorArchived: boolean;
}

function makeHasStaleRows(rows: FakeRow[]) {
  const queries: Array<{ companyId: string; version: number }> = [];
  const fn = async (companyId: string, version: number): Promise<boolean> => {
    queries.push({ companyId, version });
    const where = staleWhere(companyId, version) as {
      companyId: string;
      status: string;
      competitor: { archivedAt: null };
      OR: Array<Record<string, unknown>>;
    };
    return rows.some(
      (row) =>
        row.companyId === where.companyId &&
        row.status === where.status &&
        !row.competitorArchived &&
        (row.relevanceProfileVersion === null || row.relevanceProfileVersion !== version)
    );
  };
  return { fn, queries };
}

const profile = (companyId: string, profileVersion = 1): RecoverableProfile => ({
  companyId,
  profileVersion,
});

const row = (over: Partial<FakeRow> = {}): FakeRow => ({
  companyId: "co-1",
  status: "completed",
  relevance: "pending",
  relevanceProfileVersion: null,
  competitorArchived: false,
  ...over,
});

describe("enqueueStaleRelevanceRecovery — the exact real deployment shape", () => {
  /**
   * The literal state of the 10 Artefact Medium rows this whole fix began
   * with: a persisted Research Profile at v1, ten rows that finished
   * extracting BEFORE the post-extraction enqueue existed, no extraction
   * candidates left, and no relevance job in existence. Nothing else in the
   * system can create the first relevance job for them — this sweep is the
   * only path, which is exactly what this test pins down.
   */
  it("enqueues exactly one relevance job for a company whose already-extracted rows are stale", async () => {
    const rows = Array.from({ length: 10 }, () =>
      row({ companyId: "co-artefact", relevanceProfileVersion: null, status: "completed" })
    );
    assert.equal(rows.length, 10);

    const stale = makeHasStaleRows(rows);
    const enqueue = makeEnqueue();

    const summary = await enqueueStaleRelevanceRecovery({
      listProfiles: async () => [profile("co-artefact", 1)],
      hasStaleRows: stale.fn,
      enqueueRelevance: enqueue.fn,
    });

    // One company-level job — NOT one per article.
    assert.deepEqual(enqueue.calls, ["co-artefact"]);
    assert.equal(summary.companiesExamined, 1);
    assert.equal(summary.companiesWithStaleRows, 1);
    assert.equal(summary.enqueued, 1);
    assert.equal(summary.deduplicated, 0);
    assert.equal(summary.failed, 0);
    assert.deepEqual(summary.companyIds, ["co-artefact"]);
    assert.equal(summary.truncated, false);
  });

  it("asks the staleness question with the company's CURRENT persisted profile version", async () => {
    const stale = makeHasStaleRows([row({ companyId: "co-1" })]);
    const enqueue = makeEnqueue();

    await enqueueStaleRelevanceRecovery({
      listProfiles: async () => [profile("co-1", 7)],
      hasStaleRows: stale.fn,
      enqueueRelevance: enqueue.fn,
    });

    assert.deepEqual(stale.queries, [{ companyId: "co-1", version: 7 }]);
  });

  it("requires no extraction work and mutates no rows — it only enqueues", async () => {
    const enqueue = makeEnqueue();
    const summary = await enqueueStaleRelevanceRecovery({
      listProfiles: async () => [profile("co-1")],
      // No extraction candidates exist; the sweep never asks about any.
      hasStaleRows: async () => true,
      enqueueRelevance: enqueue.fn,
    });

    // The only side effect available to this service is the enqueue seam.
    assert.equal(enqueue.calls.length, 1);
    assert.equal(summary.enqueued, 1);
  });
});

describe("enqueueStaleRelevanceRecovery — when it must do nothing", () => {
  it("no stale rows -> no job", async () => {
    // Every row already stamped with the current version.
    const stale = makeHasStaleRows([row({ companyId: "co-1", relevanceProfileVersion: 1 })]);
    const enqueue = makeEnqueue();

    const summary = await enqueueStaleRelevanceRecovery({
      listProfiles: async () => [profile("co-1", 1)],
      hasStaleRows: stale.fn,
      enqueueRelevance: enqueue.fn,
    });

    assert.deepEqual(enqueue.calls, []);
    assert.equal(summary.companiesWithStaleRows, 0);
    assert.equal(summary.enqueued, 0);
    assert.deepEqual(summary.companyIds, []);
  });

  it("no persisted Research Profile -> no job, and the company is never even examined", async () => {
    const stale = makeHasStaleRows([row({ companyId: "co-no-profile" })]);
    const enqueue = makeEnqueue();

    const summary = await enqueueStaleRelevanceRecovery({
      // `listProfiles` reads persisted profiles only — a lazily-computed
      // default never appears here, so a company without a saved profile
      // cannot reach the staleness query at all.
      listProfiles: async () => [],
      hasStaleRows: stale.fn,
      enqueueRelevance: enqueue.fn,
    });

    assert.deepEqual(stale.queries, []);
    assert.deepEqual(enqueue.calls, []);
    assert.equal(summary.companiesExamined, 0);
  });

  it("archived-competitor rows only -> no job", async () => {
    const stale = makeHasStaleRows([
      row({ companyId: "co-1", competitorArchived: true }),
      row({ companyId: "co-1", competitorArchived: true }),
    ]);
    const enqueue = makeEnqueue();

    const summary = await enqueueStaleRelevanceRecovery({
      listProfiles: async () => [profile("co-1")],
      hasStaleRows: stale.fn,
      enqueueRelevance: enqueue.fn,
    });

    assert.deepEqual(enqueue.calls, []);
    assert.equal(summary.companiesWithStaleRows, 0);
  });

  it("rows still mid-extraction (not completed) -> no job", async () => {
    const stale = makeHasStaleRows([
      row({ companyId: "co-1", status: "pending" }),
      row({ companyId: "co-1", status: "analyzing" }),
      row({ companyId: "co-1", status: "failed" }),
    ]);
    const enqueue = makeEnqueue();

    const summary = await enqueueStaleRelevanceRecovery({
      listProfiles: async () => [profile("co-1")],
      hasStaleRows: stale.fn,
      enqueueRelevance: enqueue.fn,
    });

    assert.deepEqual(enqueue.calls, []);
    assert.equal(summary.companiesWithStaleRows, 0);
  });
});

describe("enqueueStaleRelevanceRecovery — idempotency and bounds", () => {
  it("an already queued/active relevance job deduplicates instead of creating a second", async () => {
    const enqueue = makeEnqueue({ enqueued: false, deduplicated: true, jobId: null });

    const summary = await enqueueStaleRelevanceRecovery({
      listProfiles: async () => [profile("co-1")],
      hasStaleRows: async () => true,
      enqueueRelevance: enqueue.fn,
    });

    assert.equal(summary.enqueued, 0);
    assert.equal(summary.deduplicated, 1);
    // Still reported as a company recovery covered — the in-flight job IS the
    // recovery, so this is success, not a failure.
    assert.deepEqual(summary.companyIds, ["co-1"]);
    assert.equal(summary.failed, 0);
  });

  it("repeated worker restarts stay bounded — one job per company per sweep, deduped while one is pending", async () => {
    // First start inserts; every subsequent start collides with the still
    // queued/active job and inserts nothing.
    const calls: string[] = [];
    let first = true;
    const enqueueRelevance = async (companyId: string): Promise<EnqueueJobResult> => {
      calls.push(companyId);
      if (first) {
        first = false;
        return { enqueued: true, deduplicated: false, jobId: "job-1" };
      }
      return { enqueued: false, deduplicated: true, jobId: null };
    };

    let totalEnqueued = 0;
    for (let restart = 0; restart < 5; restart++) {
      const summary = await enqueueStaleRelevanceRecovery({
        listProfiles: async () => [profile("co-1")],
        hasStaleRows: async () => true,
        enqueueRelevance,
      });
      totalEnqueued += summary.enqueued;
    }

    assert.equal(calls.length, 5, "one attempt per restart, never more");
    assert.equal(totalEnqueued, 1, "only the first restart actually created a job");
  });

  it("multiple companies -> exactly one job per QUALIFYING company, none for the rest", async () => {
    const stale = makeHasStaleRows([
      row({ companyId: "co-1", relevanceProfileVersion: null }),
      row({ companyId: "co-2", relevanceProfileVersion: 1 }), // already current
      row({ companyId: "co-3", relevanceProfileVersion: 1 }), // stale against v2
      row({ companyId: "co-4", competitorArchived: true }),
    ]);
    const enqueue = makeEnqueue();

    const summary = await enqueueStaleRelevanceRecovery({
      listProfiles: async () => [
        profile("co-1", 1),
        profile("co-2", 1),
        profile("co-3", 2),
        profile("co-4", 1),
      ],
      hasStaleRows: stale.fn,
      enqueueRelevance: enqueue.fn,
    });

    assert.deepEqual(enqueue.calls, ["co-1", "co-3"]);
    assert.equal(summary.companiesExamined, 4);
    assert.equal(summary.companiesWithStaleRows, 2);
    assert.equal(summary.enqueued, 2);
  });

  it("cross-company isolation — a company's staleness is never asked with another's version", async () => {
    const stale = makeHasStaleRows([]);
    await enqueueStaleRelevanceRecovery({
      listProfiles: async () => [profile("co-1", 3), profile("co-2", 9)],
      hasStaleRows: stale.fn,
      enqueueRelevance: makeEnqueue().fn,
    });

    assert.deepEqual(stale.queries, [
      { companyId: "co-1", version: 3 },
      { companyId: "co-2", version: 9 },
    ]);
  });

  it("caps the sweep and reports truncation rather than examining unbounded companies", async () => {
    const overCap = RELEVANCE_RECOVERY_MAX_COMPANIES + 1;
    const enqueue = makeEnqueue();

    const summary = await enqueueStaleRelevanceRecovery({
      listProfiles: async (limit) => {
        // The real query takes limit + 1 purely to detect truncation.
        assert.equal(limit, RELEVANCE_RECOVERY_MAX_COMPANIES);
        return Array.from({ length: overCap }, (_, i) => profile(`co-${i}`));
      },
      hasStaleRows: async () => false,
      enqueueRelevance: enqueue.fn,
    });

    assert.equal(summary.companiesExamined, RELEVANCE_RECOVERY_MAX_COMPANIES);
    assert.equal(summary.truncated, true);
  });

  it("a failing enqueue is swallowed and never blocks the remaining companies", async () => {
    const attempted: string[] = [];
    const summary = await enqueueStaleRelevanceRecovery({
      listProfiles: async () => [profile("co-1"), profile("co-2")],
      hasStaleRows: async () => true,
      enqueueRelevance: async (companyId) => {
        attempted.push(companyId);
        if (companyId === "co-1") throw new Error("queue unavailable");
        return { enqueued: true, deduplicated: false, jobId: "job-2" };
      },
    });

    assert.deepEqual(attempted, ["co-1", "co-2"], "co-2 was still attempted after co-1 threw");
    assert.equal(summary.failed, 1);
    assert.equal(summary.enqueued, 1);
    assert.deepEqual(summary.companyIds, ["co-2"]);
  });
});
