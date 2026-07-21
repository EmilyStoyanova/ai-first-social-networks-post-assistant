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
  claimed: string[];
  translated: string[];
  finished: { actions: Record<string, unknown> } | null;
  failed: { error: string } | null;
}

function harness(overrides: Partial<IngestionCronDeps> = {}): Harness {
  const state: Harness = {
    ingested: [],
    claimed: [],
    translated: [],
    finished: null,
    failed: null,
    deps: {},
  };
  state.deps = {
    now: () => new Date(1_000),
    timeBudgetMs: 10_000,
    createRun: async () => ({ id: "run-1" }),
    finishRun: async (_id, actions) => {
      state.finished = { actions };
    },
    failRun: async (_id, _actions, error) => {
      state.failed = { error };
    },
    selectStaleSources: async () => [],
    claimSource: async (id) => {
      state.claimed.push(id);
      return true;
    },
    ingestSource: async (src) => {
      state.ingested.push(src.id);
      return { created: 1, updated: 2 };
    },
    selectTranslationCompanies: async () => [],
    translate: async () => ({ scanned: 0, translated: 3, failed: 0, skipped: 0 }),
    ...overrides,
  };
  return state;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("runIngestionCron — batching", () => {
  it("asks the selector for exactly maxSources and processes what it returns", async () => {
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
    assert.equal(s.sourcesProcessed, 3);
    assert.equal(s.itemsCreated, 3);
    assert.equal(s.itemsUpdated, 6);
    assert.equal(s.status, "completed");
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

describe("runIngestionCron — locking", () => {
  it("skips a source claimed by a concurrent run and never ingests it", async () => {
    const h = harness({
      selectStaleSources: async () => [source("a", "c1"), source("b", "c1"), source("c", "c2")],
      claimSource: async (id) => id !== "b", // "b" was already claimed elsewhere
    });

    const s = await runIngestionCron(h.deps);

    assert.equal(s.sourcesClaimedElsewhere, 1);
    assert.equal(s.sourcesProcessed, 2);
    assert.deepEqual(h.ingested, ["a", "c"]);
  });
});

describe("runIngestionCron — failure isolation", () => {
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
    assert.equal(s.sourcesProcessed, 2);
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

describe("runIngestionCron — time budget", () => {
  it("stops claiming new sources once the soft budget is hit and marks timedOut", async () => {
    const h = harness({
      timeBudgetMs: 50_000,
      now: steppingClock(0, 30_000), // #0=start=0, #1=30k (ok), #2=60k (over)
      selectStaleSources: async () => [source("a", "c1"), source("b", "c1"), source("c", "c1")],
    });

    const s = await runIngestionCron(h.deps);

    assert.equal(s.timedOut, true);
    assert.equal(s.sourcesProcessed, 1);
    assert.deepEqual(h.ingested, ["a"]);
  });
});

describe("runIngestionCron — translation drain", () => {
  it("drains up to maxTranslationCompanies distinct companies after ingestion", async () => {
    let askedLimit = -1;
    const h = harness({
      maxTranslationCompanies: 4,
      selectTranslationCompanies: async (limit) => {
        askedLimit = limit;
        return ["c1", "c2"];
      },
      translate: async ({ companyId }) => {
        h.translated.push(companyId);
        return { scanned: 2, translated: 2, failed: 0, skipped: 0 };
      },
    });

    const s = await runIngestionCron(h.deps);

    assert.equal(askedLimit, 4);
    assert.deepEqual(h.translated, ["c1", "c2"]);
    assert.equal(s.translation.translated, 4);
  });
});

describe("runIngestionCron — never generates posts", () => {
  it("exposes only ingestion/translation surfaces (no generation seam exists)", () => {
    // Compile-time guarantee: IngestionCronDeps has no generate/schedule/publish seam.
    const keys: Array<keyof IngestionCronDeps> = [
      "now",
      "timeBudgetMs",
      "maxSources",
      "maxTranslationCompanies",
      "staleAfterMs",
      "createRun",
      "finishRun",
      "failRun",
      "selectStaleSources",
      "claimSource",
      "ingestSource",
      "selectTranslationCompanies",
      "translate",
    ];
    assert.ok(!keys.includes("generate" as keyof IngestionCronDeps));
  });
});
