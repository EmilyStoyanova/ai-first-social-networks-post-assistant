import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runGenerationCron,
  SOFT_TIME_BUDGET_MS,
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
    countRemaining: async () => 0,
    ...overrides,
  };
  return state;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("runGenerationCron — bounded deterministic batching", () => {
  it("asks the selector for exactly maxCompanies and processes what it returns, in order", async () => {
    let askedLimit = -1;
    const h = harness({
      maxCompanies: 3,
      selectCompanies: async (limit) => {
        askedLimit = limit;
        return [company("old"), company("mid"), company("new")];
      },
    });

    const s = await runGenerationCron(h.deps);

    assert.equal(askedLimit, 3);
    assert.equal(s.kind, "generation");
    assert.equal(s.status, "completed");
    assert.equal(s.examined, 3);
    assert.equal(s.processed, 3);
    assert.equal(s.failed, 0);
    assert.equal(s.skipped, 0);
    assert.equal(s.companies.length, 3);
    assert.deepEqual(h.processed, ["old", "mid", "new"]);
  });

  it("exposes a full per-phase timings shape and a durationMs equal to timings.totalMs", async () => {
    const h = harness({ selectCompanies: async () => [company("a")] });

    const s = await runGenerationCron(h.deps);

    for (const key of [
      "companySelectionMs",
      "generationMs",
      "databaseWritesMs",
      "cleanupMs",
      "totalMs",
    ] as const) {
      assert.equal(typeof s.timings[key], "number");
    }
    assert.equal(s.durationMs, s.timings.totalMs);
  });
});

describe("runGenerationCron — locking (CAS)", () => {
  it("skips a company claimed by a concurrent run and never processes it", async () => {
    const h = harness({
      selectCompanies: async () => [company("a"), company("b"), company("c")],
      claimCompany: async (id) => {
        h.claimAttempts.push(id);
        return id !== "b"; // "b" already claimed elsewhere
      },
    });

    const s = await runGenerationCron(h.deps);

    assert.equal(s.skipped, 1);
    assert.equal(s.processed, 2);
    assert.equal(s.examined, 3);
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

describe("runGenerationCron — per-company failure isolation", () => {
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
    assert.equal(s.processed, 2);
    assert.equal(s.failed, 1);
    assert.equal(s.examined, 3);
    assert.equal(s.companyFailures.length, 1);
    assert.equal(s.companyFailures[0].slug, "slug-bad");
    assert.match(s.companyFailures[0].message, /LLM down/);
    assert.deepEqual(h.processed, ["a", "c"]);
  });
});

describe("runGenerationCron — soft deadline between companies", () => {
  it("SOFT_TIME_BUDGET_MS is the production 240s deadline", () => {
    assert.equal(SOFT_TIME_BUDGET_MS, 240_000);
  });

  it("stops before claiming past the soft budget; unprocessed companies stay unclaimed", async () => {
    const h = harness({
      timeBudgetMs: 50_000,
      // #0=start=0, #1=30k (ok), #2=60k (over) — checked before each company.
      now: steppingClock(0, 30_000),
      selectCompanies: async () => [company("a"), company("b"), company("c")],
    });

    const s = await runGenerationCron(h.deps);

    assert.equal(s.timedOut, true);
    assert.equal(s.processed, 1);
    assert.deepEqual(h.processed, ["a"]);
    // Critical: "b" and "c" were never claimed, so the next run picks them up.
    assert.deepEqual(h.claimAttempts, ["a"]);
  });

  it("does NOT mark timedOut when the batch drains within budget", async () => {
    const h = harness({ selectCompanies: async () => [company("a"), company("b")] });

    const s = await runGenerationCron(h.deps);

    assert.equal(s.timedOut, false);
    assert.equal(s.processed, 2);
  });
});

describe("runGenerationCron — shouldStop threaded into processCompany", () => {
  it("passes a live, budget-aware shouldStop into each company's step pipeline", async () => {
    // Budget 50s. The clock steps 20s per call: start(0), overBudget-check before "a"(20k,
    // under), then the two shouldStop() probes inside processCompany read 40k (under) and
    // 60k (over). So the callback flips true partway through the company — proving the
    // deadline reaches inside the per-company work, not just between companies.
    const probes: boolean[] = [];
    const h = harness({
      timeBudgetMs: 50_000,
      now: steppingClock(0, 20_000),
      selectCompanies: async () => [company("a")],
      processCompany: async (_c, { shouldStop }) => {
        probes.push(shouldStop());
        probes.push(shouldStop());
        return {};
      },
    });

    const s = await runGenerationCron(h.deps);

    assert.equal(s.processed, 1);
    assert.deepEqual(probes, [false, true]);
  });
});

describe("runGenerationCron — continuation across runs", () => {
  it("resumes the still-unprocessed companies on the next run (oldest-first cursor)", async () => {
    // Three companies, batch cap 2, and a budget that only lets one through per run. The CAS
    // claim advances each processed company's cursor, so selection (oldest-first) hands the
    // next run the companies the previous run never reached — draining all three in order,
    // each exactly once.
    const cursor = new Map<string, Date | null>([
      ["a", null],
      ["b", null],
      ["c", null],
    ]);
    const order = ["a", "b", "c"];
    const processedAcrossRuns: string[] = [];

    const cursorValue = (id: string) => {
      const p = cursor.get(id) ?? null;
      return p === null ? -Infinity : p.getTime();
    };

    function oneShot(nowMs: number): GenerationCronDeps {
      return {
        // Trips the budget after the first company: start(nowMs), check#1=+60k (under 100k
        // deadline → process one), check#2=+120k (over → stop).
        now: steppingClock(nowMs, 60_000),
        timeBudgetMs: 100_000,
        maxCompanies: 2,
        createRun: async () => ({ id: `run-${nowMs}` }),
        finishRun: async () => {},
        failRun: async () => {},
        // Oldest-first (stable) — the same order the real `lastCronProcessedAt asc` selector gives.
        selectCompanies: async (limit) =>
          [...order]
            .sort((x, y) => cursorValue(x) - cursorValue(y))
            .slice(0, limit)
            .map((id) => company(id, cursor.get(id) ?? null)),
        claimCompany: async (id, prev) => {
          const cur = cursor.get(id) ?? null;
          if ((cur?.getTime() ?? null) !== (prev?.getTime() ?? null)) return false;
          cursor.set(id, new Date(nowMs));
          return true;
        },
        processCompany: async (c) => {
          processedAcrossRuns.push(c.id);
          return {};
        },
        countRemaining: async () => 0,
      };
    }

    const r1 = await runGenerationCron(oneShot(1_000));
    const r2 = await runGenerationCron(oneShot(2_000));
    const r3 = await runGenerationCron(oneShot(3_000));

    assert.equal(r1.processed, 1);
    assert.equal(r1.timedOut, true);
    assert.equal(r2.processed, 1);
    assert.equal(r3.processed, 1);
    // Every company processed exactly once, in oldest-first order — nothing lost, nothing doubled.
    assert.deepEqual(processedAcrossRuns, ["a", "b", "c"]);
  });
});

describe("runGenerationCron — remaining backlog count", () => {
  it("surfaces countRemaining for companies still awaiting this cycle", async () => {
    let seenBefore: Date | undefined;
    const h = harness({
      now: () => new Date(7_000),
      selectCompanies: async () => [company("a")],
      countRemaining: async (before) => {
        seenBefore = before;
        return 4;
      },
    });

    const s = await runGenerationCron(h.deps);

    assert.equal(s.remaining, 4);
    // The backlog is measured against this run's start time.
    assert.equal(seenBefore?.getTime(), 7_000);
  });
});

describe("runGenerationCron — diagnostics & CronRun persistence", () => {
  it("records the full diagnostics (kind, counters, timings) in actionsTaken on success", async () => {
    let finished: { id: string; actions: Record<string, unknown> } | undefined;
    const h = harness({
      selectCompanies: async () => [company("a")],
      processCompany: async () => ({ weeklySchedule: { postsGenerated: 2 }, publish: { sent: 1 } }),
      finishRun: async (id, actions) => {
        finished = { id, actions };
      },
    });

    const s = await runGenerationCron(h.deps);

    assert.equal(s.companies[0].slug, "slug-a");
    assert.deepEqual(s.companies[0].actions.weeklySchedule, { postsGenerated: 2 });
    assert.ok(finished);
    assert.equal(finished.id, "run-1");
    assert.equal(finished.actions.kind, "generation");
    assert.equal(finished.actions.examined, 1);
    assert.equal(finished.actions.processed, 1);
    assert.equal(finished.actions.remaining, 0);
    assert.ok(finished.actions.timings);
    assert.equal(typeof (finished.actions.timings as Record<string, unknown>).totalMs, "number");
  });

  it("records failRun with the kind and error when the orchestrator itself throws", async () => {
    let failed: { actions: Record<string, unknown>; error: string } | undefined;
    const h = harness({
      selectCompanies: async () => {
        throw new Error("db unreachable");
      },
      failRun: async (_id, actions, error) => {
        failed = { actions, error };
      },
    });

    const s = await runGenerationCron(h.deps);

    assert.equal(s.status, "failed");
    assert.match(s.error ?? "", /db unreachable/);
    assert.ok(failed);
    assert.equal(failed.actions.kind, "generation");
    assert.match(failed.error, /db unreachable/);
  });
});
