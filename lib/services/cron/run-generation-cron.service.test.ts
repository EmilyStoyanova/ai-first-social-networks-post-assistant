import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runGenerationCron,
  type GenerationCronDeps,
  type GenerationCronCompany,
} from "./run-generation-cron.service";

// ─── Helpers ────────────────────────────────────────────────────────────────

function company(id: string, lastCronProcessedAt: Date | null = null): GenerationCronCompany {
  return { id, slug: `slug-${id}`, automationMode: "semi_automated", lastCronProcessedAt };
}

/** A clock that advances by `stepMs` on every call — lets tests trip the time budget. */
function steppingClock(baseMs: number, stepMs: number): () => Date {
  let n = 0;
  return () => new Date(baseMs + stepMs * n++);
}

interface Harness {
  deps: GenerationCronDeps;
  processed: string[];
  claimAttempts: string[];
}

function harness(overrides: Partial<GenerationCronDeps> = {}): Harness {
  const state: Harness = { processed: [], claimAttempts: [], deps: {} };
  state.deps = {
    now: () => new Date(1_000),
    timeBudgetMs: 10_000,
    createRun: async () => ({ id: "run-1" }),
    finishRun: async () => {},
    failRun: async () => {},
    selectCompanies: async () => [],
    claimCompany: async (id) => {
      state.claimAttempts.push(id);
      return true;
    },
    processCompany: async (c) => {
      state.processed.push(c.id);
      return { weeklySchedule: { postsGenerated: 1 } };
    },
    ...overrides,
  };
  return state;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("runGenerationCron — batching", () => {
  it("asks the selector for exactly maxCompanies and processes what it returns", async () => {
    let askedLimit = -1;
    const h = harness({
      maxCompanies: 3,
      selectCompanies: async (limit) => {
        askedLimit = limit;
        return [company("a"), company("b")];
      },
    });

    const s = await runGenerationCron(h.deps);

    assert.equal(askedLimit, 3);
    assert.equal(s.companiesProcessed, 2);
    assert.equal(s.companies.length, 2);
    assert.equal(s.status, "completed");
  });
});

describe("runGenerationCron — fairness (oldest-first order preserved)", () => {
  it("processes companies in the order the selector returns", async () => {
    const h = harness({
      selectCompanies: async () => [company("old"), company("mid"), company("new")],
    });

    await runGenerationCron(h.deps);

    assert.deepEqual(h.processed, ["old", "mid", "new"]);
  });
});

describe("runGenerationCron — locking", () => {
  it("skips a company claimed by a concurrent run and never processes it", async () => {
    const h = harness({
      selectCompanies: async () => [company("a"), company("b"), company("c")],
      claimCompany: async (id) => id !== "b", // "b" already claimed elsewhere
    });

    const s = await runGenerationCron(h.deps);

    assert.equal(s.companiesClaimedElsewhere, 1);
    assert.equal(s.companiesProcessed, 2);
    assert.deepEqual(h.processed, ["a", "c"]);
  });

  it("claims each company with the exact lastCronProcessedAt it read (CAS version)", async () => {
    const t = new Date(5_000);
    let seenPrev: Date | null | undefined;
    const h = harness({
      selectCompanies: async () => [company("a", t)],
      claimCompany: async (_id, prev) => {
        seenPrev = prev;
        return true;
      },
    });

    await runGenerationCron(h.deps);

    assert.equal(seenPrev?.getTime(), t.getTime());
  });
});

describe("runGenerationCron — failure isolation", () => {
  it("records a failing company and still processes the rest; run completes", async () => {
    const h = harness({
      selectCompanies: async () => [company("a"), company("bad"), company("c")],
      processCompany: async (c) => {
        if (c.id === "bad") throw new Error("LLM down");
        h.processed.push(c.id);
        return {};
      },
    });

    const s = await runGenerationCron(h.deps);

    assert.equal(s.status, "completed");
    assert.equal(s.companiesProcessed, 2);
    assert.equal(s.companyFailures.length, 1);
    assert.equal(s.companyFailures[0].slug, "slug-bad");
    assert.match(s.companyFailures[0].message, /LLM down/);
    assert.deepEqual(h.processed, ["a", "c"]);
  });
});

describe("runGenerationCron — time budget", () => {
  it("stops before claiming past the soft budget; unprocessed companies stay unclaimed", async () => {
    const h = harness({
      timeBudgetMs: 50_000,
      now: steppingClock(0, 30_000), // #0=start=0, #1=30k (ok), #2=60k (over)
      selectCompanies: async () => [company("a"), company("b"), company("c")],
    });

    const s = await runGenerationCron(h.deps);

    assert.equal(s.timedOut, true);
    assert.equal(s.companiesProcessed, 1);
    assert.deepEqual(h.processed, ["a"]);
    // Critical: "b" and "c" were never claimed, so the next run picks them up.
    assert.deepEqual(h.claimAttempts, ["a"]);
  });
});

describe("runGenerationCron — diagnostics", () => {
  it("returns per-company step actions and a generation kind", async () => {
    const h = harness({
      selectCompanies: async () => [company("a")],
      processCompany: async () => ({ weeklySchedule: { postsGenerated: 2 }, publish: { sent: 1 } }),
    });

    const s = await runGenerationCron(h.deps);

    assert.equal(s.kind, "generation");
    assert.equal(s.companies[0].slug, "slug-a");
    assert.deepEqual(s.companies[0].actions.weeklySchedule, { postsGenerated: 2 });
  });
});
