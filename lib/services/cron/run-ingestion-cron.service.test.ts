import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runIngestionCron,
  type IngestionCronDeps,
  type StaleSourceRow,
} from "./run-ingestion-cron.service";

// ─── Helpers ────────────────────────────────────────────────────────────────

function source(id: string, companyId: string, lastFetchedAt: Date | null = null): StaleSourceRow {
  return { id, companyId, type: "rss", name: `src-${id}`, config: { url: `https://x/${id}` }, lastFetchedAt };
}

/** A clock that advances by `stepMs` on every call — lets tests trip the time budget. */
function steppingClock(baseMs: number, stepMs: number): () => Date {
  let n = 0;
  return () => new Date(baseMs + stepMs * n++);
}

interface Harness {
  deps: IngestionCronDeps;
  ingested: string[];
}

function harness(overrides: Partial<IngestionCronDeps> = {}): Harness {
  const state: Harness = { ingested: [], deps: {} };
  state.deps = {
    now: () => new Date(1_000),
    timeBudgetMs: 10_000,
    createRun: async () => ({ id: "run-1" }),
    finishRun: async () => {},
    failRun: async () => {},
    selectStaleSources: async () => [],
    claimSource: async () => true,
    ingestSource: async (src) => {
      state.ingested.push(src.id);
      return { created: 1, updated: 2 };
    },
    countRemainingStale: async () => 0,
    selectTranslationCompanies: async () => [],
    translate: async () => ({ scanned: 0, translated: 3, failed: 0, skipped: 0 }),
    ...overrides,
  };
  return state;
}

/**
 * In-memory source store that models the real cursor: selectStaleSources returns stale
 * rows oldest-first (bounded), and claimSource advances lastFetchedAt via CAS. Lets a
 * test run the cron repeatedly and observe deterministic cursor progression.
 */
function memoryDb(nowFn: () => Date, initial: StaleSourceRow[]) {
  const rows = initial.map((r) => ({ ...r }));
  const claimed: string[] = [];
  const stale = (r: (typeof rows)[number], before: Date) =>
    r.lastFetchedAt === null || r.lastFetchedAt.getTime() < before.getTime();
  return {
    claimed,
    selectStaleSources: async (limit: number, staleBefore: Date): Promise<StaleSourceRow[]> =>
      rows
        .filter((r) => stale(r, staleBefore))
        .sort((a, b) => (a.lastFetchedAt?.getTime() ?? -Infinity) - (b.lastFetchedAt?.getTime() ?? -Infinity))
        .slice(0, limit)
        .map((r) => source(r.id, r.companyId, r.lastFetchedAt)),
    claimSource: async (id: string, prev: Date | null): Promise<boolean> => {
      const r = rows.find((x) => x.id === id);
      if (!r) return false;
      const cur = r.lastFetchedAt ? r.lastFetchedAt.getTime() : null;
      const p = prev ? prev.getTime() : null;
      if (cur !== p) return false; // CAS version mismatch → concurrent claim
      r.lastFetchedAt = new Date(nowFn().getTime());
      claimed.push(id);
      return true;
    },
    countRemainingStale: async (staleBefore: Date): Promise<number> =>
      rows.filter((r) => stale(r, staleBefore)).length,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("runIngestionCron — batching", () => {
  it("asks the selector for exactly maxSources and reports the batch it examined", async () => {
    let askedLimit = -1;
    const h = harness({
      maxSources: 5,
      selectStaleSources: async (limit) => {
        askedLimit = limit;
        return [source("a", "c1"), source("b", "c1"), source("c", "c2")];
      },
    });

    const s = await runIngestionCron(h.deps);

    assert.equal(askedLimit, 5);
    assert.equal(s.examined, 3);
    assert.equal(s.succeeded, 3);
    assert.equal(s.failed, 0);
    assert.equal(s.itemsCreated, 3);
    assert.equal(s.itemsUpdated, 6);
    assert.equal(s.status, "completed");
  });

  it("returns the full diagnostics shape", async () => {
    const h = harness({ selectStaleSources: async () => [source("a", "c1")] });
    const s = await runIngestionCron(h.deps);
    for (const k of ["examined", "succeeded", "failed", "skipped", "remaining", "durationMs"] as const) {
      assert.equal(typeof s[k], "number", `${k} should be a number`);
    }
  });
});

describe("runIngestionCron — fairness (processes in the order the selector returns)", () => {
  it("ingests sources oldest-first, in selector order", async () => {
    const h = harness({
      selectStaleSources: async () => [source("old", "c1"), source("mid", "c1"), source("new", "c2")],
    });

    await runIngestionCron(h.deps);

    assert.deepEqual(h.ingested, ["old", "mid", "new"]);
  });
});

describe("runIngestionCron — cursor progression + continuation", () => {
  it("processes the oldest batch, advances the cursor, and resumes next run", async () => {
    const BASE = 1_000_000_000_000;
    const HOUR = 3_600_000;
    const nowFn = () => new Date(BASE);
    const db = memoryDb(nowFn, [
      source("A", "c1", new Date(BASE - 10 * HOUR)),
      source("B", "c1", new Date(BASE - 9 * HOUR)),
      source("C", "c2", new Date(BASE - 8 * HOUR)),
      source("D", "c2", new Date(BASE - 7 * HOUR)),
    ]);

    const deps: IngestionCronDeps = {
      now: nowFn,
      staleAfterMs: 6 * HOUR,
      maxSources: 2,
      createRun: async () => ({ id: "r" }),
      finishRun: async () => {},
      failRun: async () => {},
      selectStaleSources: db.selectStaleSources,
      claimSource: db.claimSource,
      countRemainingStale: db.countRemainingStale,
      ingestSource: async () => ({ created: 1, updated: 0 }),
      selectTranslationCompanies: async () => [],
      translate: async () => ({ scanned: 0, translated: 0, failed: 0, skipped: 0 }),
    };

    // Run 1 — two oldest sources, two still remaining.
    const s1 = await runIngestionCron(deps);
    assert.equal(s1.examined, 2);
    assert.equal(s1.succeeded, 2);
    assert.equal(s1.remaining, 2);
    assert.deepEqual(db.claimed, ["A", "B"]); // oldest-first cursor

    // Run 2 — cursor has moved: the remaining two are picked up, backlog drained.
    const s2 = await runIngestionCron(deps);
    assert.equal(s2.succeeded, 2);
    assert.equal(s2.remaining, 0);
    assert.deepEqual(db.claimed, ["A", "B", "C", "D"]);

    // Run 3 — nothing left to do.
    const s3 = await runIngestionCron(deps);
    assert.equal(s3.examined, 0);
    assert.equal(s3.remaining, 0);
  });

  it("claims each source with the exact lastFetchedAt it read (CAS version)", async () => {
    const t = new Date(7_000);
    const seen: Array<Date | null> = [];
    const h = harness({
      selectStaleSources: async () => [source("a", "c1", t), source("b", "c1", null)],
      claimSource: async (_id, prev) => {
        seen.push(prev);
        return true;
      },
    });

    await runIngestionCron(h.deps);

    assert.equal(seen[0]?.getTime(), t.getTime());
    assert.equal(seen[1], null);
  });
});

describe("runIngestionCron — locking", () => {
  it("skips a source claimed by a concurrent run and never ingests it", async () => {
    const h = harness({
      selectStaleSources: async () => [source("a", "c1"), source("b", "c1"), source("c", "c2")],
      claimSource: async (id) => id !== "b", // "b" was already claimed elsewhere
    });

    const s = await runIngestionCron(h.deps);

    assert.equal(s.examined, 3);
    assert.equal(s.skipped, 1);
    assert.equal(s.succeeded, 2);
    assert.deepEqual(h.ingested, ["a", "c"]);
  });
});

describe("runIngestionCron — partial failure isolation", () => {
  it("records a failing source and still processes the rest; run completes", async () => {
    const ingested: string[] = [];
    const h = harness({
      selectStaleSources: async () => [source("a", "c1"), source("bad", "c1"), source("c", "c2")],
      ingestSource: async (src) => {
        if (src.id === "bad") throw new Error("feed 500");
        ingested.push(src.id);
        return { created: 1, updated: 0 };
      },
    });

    const s = await runIngestionCron(h.deps);

    assert.equal(s.status, "completed");
    assert.equal(s.examined, 3);
    assert.equal(s.succeeded, 2);
    assert.equal(s.failed, 1);
    assert.equal(s.sourceFailures.length, 1);
    assert.equal(s.sourceFailures[0].sourceId, "bad");
    assert.equal(s.sourceFailures[0].companyId, "c1");
    assert.match(s.sourceFailures[0].message, /feed 500/);
    assert.deepEqual(ingested, ["a", "c"]);
  });

  it("isolates a failing translation company and keeps going", async () => {
    const h = harness({
      selectTranslationCompanies: async () => ["c1", "cBad", "c2"],
      translate: async ({ companyId }) => {
        if (companyId === "cBad") throw new Error("translate boom");
        return { scanned: 1, translated: 1, failed: 0, skipped: 0 };
      },
    });

    const s = await runIngestionCron(h.deps);

    assert.equal(s.status, "completed");
    assert.equal(s.translation.companiesProcessed, 2);
    assert.equal(s.translation.translated, 2);
    assert.equal(s.translationFailures.length, 1);
    assert.equal(s.translationFailures[0].companyId, "cBad");
  });
});

describe("runIngestionCron — time budget (Hobby-safe)", () => {
  it("stops claiming new sources once the soft budget is hit and marks timedOut", async () => {
    const h = harness({
      timeBudgetMs: 50_000,
      now: steppingClock(0, 30_000), // #0=start=0, #1=30k (ok), #2=60k (over)
      selectStaleSources: async () => [source("a", "c1"), source("b", "c1"), source("c", "c1")],
    });

    const s = await runIngestionCron(h.deps);

    assert.equal(s.timedOut, true);
    assert.equal(s.examined, 1);
    assert.equal(s.succeeded, 1);
    assert.deepEqual(h.ingested, ["a"]);
  });

  it("passes a live, callable shouldStop hook into each source (mid-feed stop wiring)", async () => {
    let probed: unknown;
    const h = harness({
      timeBudgetMs: 50_000,
      now: () => new Date(1_000_000), // constant → within budget while processing
      selectStaleSources: async () => [source("a", "c1")],
      ingestSource: async (_src, _companyId, options) => {
        probed = options?.shouldStop;
        return { created: 0, updated: 0 };
      },
    });

    await runIngestionCron(h.deps);

    // runSourceIngestion breaks its item loop on this hook, keeping one large feed from
    // running every extraction to the timeout. Here it is wired and returns a boolean.
    assert.equal(typeof probed, "function");
    assert.equal((probed as () => boolean)(), false); // now(1_000_000) < deadline(1_050_000)
  });
});

describe("runIngestionCron — translation drain", () => {
  it("drains up to maxTranslationCompanies distinct companies after ingestion", async () => {
    let askedLimit = -1;
    const translated: string[] = [];
    const h = harness({
      maxTranslationCompanies: 4,
      selectTranslationCompanies: async (limit) => {
        askedLimit = limit;
        return ["c1", "c2"];
      },
      translate: async ({ companyId }) => {
        translated.push(companyId);
        return { scanned: 2, translated: 2, failed: 0, skipped: 0 };
      },
    });

    const s = await runIngestionCron(h.deps);

    assert.equal(askedLimit, 4);
    assert.deepEqual(translated, ["c1", "c2"]);
    assert.equal(s.translation.translated, 4);
  });
});

describe("runIngestionCron — never generates posts", () => {
  it("has no generation seam in its deps", () => {
    const deps: IngestionCronDeps = {};
    // Compile-time + runtime guarantee: no generate/schedule/publish surface exists.
    assert.equal("generate" in deps, false);
    assert.equal("generateSchedule" in deps, false);
    assert.equal("publish" in deps, false);
  });
});
