import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runTranslationCron,
  SOFT_TIME_BUDGET_MS,
  type TranslationCronDeps,
} from "./run-translation-cron.service";
import type { TranslateFeedItemsSummary } from "./translate-feed-items.service";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** A clock that advances by `stepMs` on every call — lets tests trip the time budget. */
function steppingClock(baseMs: number, stepMs: number): () => Date {
  let n = 0;
  return () => new Date(baseMs + stepMs * n++);
}

interface Harness {
  deps: TranslationCronDeps;
  translated: string[];
  finished: Array<Record<string, unknown>>;
  failed: Array<{ actions: Record<string, unknown>; error: string }>;
}

const OK: TranslateFeedItemsSummary = { scanned: 2, translated: 2, failed: 0, skipped: 0 };

function harness(overrides: Partial<TranslationCronDeps> = {}): Harness {
  const state: Harness = { translated: [], finished: [], failed: [], deps: {} };
  state.deps = {
    now: () => new Date(1_000),
    timeBudgetMs: 10_000,
    createRun: async () => ({ id: "run-1" }),
    finishRun: async (_id, actions) => {
      state.finished.push(actions);
    },
    failRun: async (_id, actions, error) => {
      state.failed.push({ actions, error });
    },
    selectCompanies: async () => [],
    translate: async ({ companyId }) => {
      state.translated.push(companyId);
      return OK;
    },
    countRemaining: async () => 0,
    ...overrides,
  };
  return state;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("runTranslationCron — bounded batching", () => {
  it("asks the selector for exactly maxCompanies and drains the batch it examined", async () => {
    let askedLimit = -1;
    const h = harness({
      maxCompanies: 5,
      selectCompanies: async (limit) => {
        askedLimit = limit;
        return ["c1", "c2", "c3"];
      },
      translate: async ({ companyId }) => {
        h.translated.push(companyId);
        return { scanned: 2, translated: 2, failed: 0, skipped: 1 };
      },
    });

    const s = await runTranslationCron(h.deps);

    assert.equal(askedLimit, 5);
    assert.equal(s.companiesExamined, 3);
    assert.equal(s.companiesProcessed, 3);
    assert.equal(s.translated, 6);
    assert.equal(s.skipped, 3);
    assert.equal(s.failed, 0);
    assert.equal(s.status, "completed");
    assert.deepEqual(h.translated, ["c1", "c2", "c3"]);
  });

  it("processes companies in selector order (oldest-first)", async () => {
    const h = harness({ selectCompanies: async () => ["old", "mid", "new"] });
    await runTranslationCron(h.deps);
    assert.deepEqual(h.translated, ["old", "mid", "new"]);
  });

  it("returns the full diagnostics shape", async () => {
    const h = harness({ selectCompanies: async () => ["c1"] });
    const s = await runTranslationCron(h.deps);
    for (const k of [
      "companiesExamined",
      "companiesProcessed",
      "translated",
      "failed",
      "skipped",
      "remaining",
      "durationMs",
    ] as const) {
      assert.equal(typeof s[k], "number", `${k} should be a number`);
    }
    assert.equal(s.kind, "translation");
    for (const k of [
      "companySelectionMs",
      "translationMs",
      "databaseWritesMs",
      "cleanupMs",
      "totalMs",
    ] as const) {
      assert.equal(typeof s.timings[k], "number", `timings.${k} should be a number`);
      assert.ok(s.timings[k] >= 0, `timings.${k} should be >= 0`);
    }
    assert.equal(s.durationMs, s.timings.totalMs);
  });
});

describe("runTranslationCron — continuation across runs", () => {
  it("drains the backlog across successive runs and reports the shrinking remainder", async () => {
    // In-memory backlog: each company holds a queue of pending items; a run translates at
    // most `batch` per company (the real translateFeedItems is batch-bounded), so a large
    // company needs several runs. Unfinished items stay pending → re-selected next run.
    const batch = 2;
    const pending: Record<string, number> = { c1: 5, c2: 1 };
    const withPending = () => Object.keys(pending).filter((c) => pending[c] > 0);

    const deps: TranslationCronDeps = {
      now: () => new Date(1_000),
      timeBudgetMs: 10_000,
      createRun: async () => ({ id: "r" }),
      finishRun: async () => {},
      failRun: async () => {},
      selectCompanies: async (limit) => withPending().slice(0, limit),
      translate: async ({ companyId }) => {
        const take = Math.min(batch, pending[companyId]);
        pending[companyId] -= take;
        return { scanned: take, translated: take, failed: 0, skipped: 0 };
      },
      countRemaining: async () => withPending().reduce((sum, c) => sum + pending[c], 0),
    };

    // Run 1: c1 -2 (→3), c2 -1 (→0). 3 remain.
    const s1 = await runTranslationCron(deps);
    assert.equal(s1.translated, 3);
    assert.equal(s1.remaining, 3);

    // Run 2: c1 -2 (→1). 1 remains.
    const s2 = await runTranslationCron(deps);
    assert.equal(s2.translated, 2);
    assert.equal(s2.remaining, 1);

    // Run 3: c1 -1 (→0). Backlog drained.
    const s3 = await runTranslationCron(deps);
    assert.equal(s3.translated, 1);
    assert.equal(s3.remaining, 0);

    // Run 4: nothing left.
    const s4 = await runTranslationCron(deps);
    assert.equal(s4.companiesExamined, 0);
    assert.equal(s4.remaining, 0);
  });
});

describe("runTranslationCron — deadline interruption", () => {
  it("defaults the soft deadline to 240s (60s headroom under the 300s route cap)", () => {
    assert.equal(SOFT_TIME_BUDGET_MS, 240_000);
  });

  it("stops draining new companies once the soft budget is hit and marks timedOut", async () => {
    const h = harness({
      timeBudgetMs: 50_000,
      now: steppingClock(0, 30_000), // #0=start=0, #1=30k (ok), #2=60k (over)
      selectCompanies: async () => ["c1", "c2", "c3"],
    });

    const s = await runTranslationCron(h.deps);

    assert.equal(s.timedOut, true);
    assert.equal(s.companiesExamined, 1);
    assert.equal(s.companiesProcessed, 1);
    assert.deepEqual(h.translated, ["c1"]);
  });

  it("does NOT mark timedOut when the deadline passed but nothing was pending", async () => {
    const h = harness({
      timeBudgetMs: 50_000,
      now: steppingClock(0, 60_000),
      selectCompanies: async () => [],
    });

    const s = await runTranslationCron(h.deps);

    assert.equal(s.companiesExamined, 0);
    assert.equal(s.timedOut, false);
  });

  it("passes a live shouldStop hook into each company (between-item interruption wiring)", async () => {
    let probed: unknown;
    const h = harness({
      timeBudgetMs: 50_000,
      now: () => new Date(1_000_000), // constant → within budget while processing
      selectCompanies: async () => ["c1"],
      translate: async (opts) => {
        probed = opts.shouldStop;
        return OK;
      },
    });

    await runTranslationCron(h.deps);

    // translateFeedItems breaks its item loop on this hook, so a long backlog stops between
    // items instead of running every LLM call to the timeout.
    assert.equal(typeof probed, "function");
    assert.equal((probed as () => boolean)(), false); // now(1_000_000) < deadline(1_050_000)
  });
});

describe("runTranslationCron — partial company failure", () => {
  it("records a failing company and still drains the rest; run completes", async () => {
    const drained: string[] = [];
    const h = harness({
      selectCompanies: async () => ["c1", "cBad", "c2"],
      translate: async ({ companyId }) => {
        if (companyId === "cBad") throw new Error("translate boom");
        drained.push(companyId);
        return { scanned: 1, translated: 1, failed: 0, skipped: 0 };
      },
    });

    const s = await runTranslationCron(h.deps);

    assert.equal(s.status, "completed");
    assert.equal(s.companiesExamined, 3);
    assert.equal(s.companiesProcessed, 2);
    assert.equal(s.translated, 2);
    assert.equal(s.failures.length, 1);
    assert.equal(s.failures[0].companyId, "cBad");
    assert.match(s.failures[0].message, /translate boom/);
    assert.deepEqual(drained, ["c1", "c2"]);
  });

  it("counts per-item failures without aborting the batch", async () => {
    const h = harness({
      selectCompanies: async () => ["c1", "c2"],
      translate: async ({ companyId }) =>
        companyId === "c1"
          ? { scanned: 3, translated: 1, failed: 2, skipped: 0 }
          : { scanned: 2, translated: 2, failed: 0, skipped: 0 },
    });

    const s = await runTranslationCron(h.deps);

    assert.equal(s.translated, 3);
    assert.equal(s.failed, 2);
    assert.equal(s.companiesProcessed, 2);
  });
});

describe("runTranslationCron — remaining backlog count", () => {
  it("surfaces the post-run backlog from countRemaining", async () => {
    const h = harness({
      selectCompanies: async () => ["c1"],
      countRemaining: async () => 7,
    });

    const s = await runTranslationCron(h.deps);
    assert.equal(s.remaining, 7);
  });
});

describe("runTranslationCron — diagnostics & CronRun persistence", () => {
  it("persists the summary (kind + counters + timings) in actionsTaken on success", async () => {
    const h = harness({
      selectCompanies: async () => ["c1", "c2"],
      countRemaining: async () => 4,
    });

    await runTranslationCron(h.deps);

    assert.equal(h.finished.length, 1);
    const a = h.finished[0];
    assert.equal(a.kind, "translation");
    assert.equal(a.companiesExamined, 2);
    assert.equal(a.companiesProcessed, 2);
    assert.equal(a.translated, 4);
    assert.equal(a.remaining, 4);
    assert.equal(a.timedOut, false);
    assert.ok(a.timings, "timings must be recorded");
    assert.deepEqual(a.failures, []);
    assert.equal(h.failed.length, 0);
  });

  it("marks the CronRun failed and records the error when the orchestrator throws", async () => {
    const h = harness({
      selectCompanies: async () => {
        throw new Error("db down");
      },
    });

    const s = await runTranslationCron(h.deps);

    assert.equal(s.status, "failed");
    assert.match(s.error ?? "", /db down/);
    assert.equal(h.failed.length, 1);
    assert.match(h.failed[0].error, /db down/);
    assert.equal((h.failed[0].actions as { kind: string }).kind, "translation");
    assert.equal(h.finished.length, 0);
  });
});
