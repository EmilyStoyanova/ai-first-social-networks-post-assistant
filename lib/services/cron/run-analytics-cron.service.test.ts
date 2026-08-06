import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { runAnalyticsCron, type AnalyticsCronCompany } from "./run-analytics-cron.service";
import type {
  SyncPostMetricsOptions,
  SyncPostMetricsSummary,
} from "@/lib/services/analytics/sync-post-metrics.service";

/**
 * The company-level half of the coverage guarantee.
 *
 * Analytics used to ride along as the last step of the generation cron, which
 * processes at most 5 companies per run. A sixth company therefore had its metrics
 * refreshed every other day at best — and, once the manual refresh button was
 * removed, with no way for its owner to force the issue.
 *
 * These tests drive the orchestrator against an in-memory world: every company
 * holds a backlog of pending posts, and the fake sync drains it the way the real
 * one does. What is asserted is the loop's behaviour across runs — that everyone
 * makes progress, that nobody starves, and that the daily request budget holds.
 */

interface FakeCompany {
  id: string;
  slug: string;
  /** Posts still awaiting today's read. */
  pending: number;
  /** Posts already read today, across every run — the budget spend. */
  readToday: number;
}

let world: FakeCompany[];
let syncCalls: Array<{ companyId: string; limit: number }>;

function company(id: string, pending: number, readToday = 0): FakeCompany {
  return { id, slug: id, pending, readToday };
}

/**
 * Stands in for the Prisma selector: only companies with work left, stalest first.
 * "Stalest" here is simply "most still pending", which is the same shape of
 * ordering the real query gets from `_min(collectedAt)`.
 */
async function selectCompanies(limit: number): Promise<AnalyticsCronCompany[]> {
  return world
    .filter((c) => c.pending > 0)
    .sort((a, b) => b.pending - a.pending)
    .slice(0, limit)
    .map((c) => ({ id: c.id, slug: c.slug }));
}

async function countReadToday(companyId: string): Promise<number> {
  return world.find((c) => c.id === companyId)?.readToday ?? 0;
}

/** Drains up to `limit` of a company's backlog, as the real sync would. */
async function fakeSync(options: SyncPostMetricsOptions): Promise<SyncPostMetricsSummary> {
  const limit = options.limit ?? 15;
  syncCalls.push({ companyId: options.companyId, limit });

  const target = world.find((c) => c.id === options.companyId)!;
  const read = Math.min(limit, target.pending);
  target.pending -= read;
  target.readToday += read;

  return {
    skipped: false,
    examined: read,
    updated: read,
    noData: 0,
    forbidden: 0,
    notFound: 0,
    failed: 0,
    remaining: target.pending,
    stoppedEarly: false,
  };
}

const runRecorder = {
  createRun: async () => ({ id: "run-1" }),
  finishRun: async () => {},
  failRun: async () => {},
};

function cron(over: Parameters<typeof runAnalyticsCron>[0] = {}) {
  return runAnalyticsCron({
    ...runRecorder,
    selectCompanies,
    countReadToday,
    sync: fakeSync,
    ...over,
  });
}

beforeEach(() => {
  syncCalls = [];
});

describe("runAnalyticsCron — every company makes progress", () => {
  beforeEach(() => {
    // Eight companies, more than the generation cron's five-per-run ceiling.
    world = Array.from({ length: 8 }, (_, i) => company(`c${i + 1}`, 40));
  });

  it("covers every company's backlog over repeated runs", async () => {
    let guard = 0;
    while (world.some((c) => c.pending > 0) && guard++ < 20) {
      await cron({ maxCompanies: 3, perCompanyLimit: 25 });
    }

    assert.deepEqual(
      world.filter((c) => c.pending > 0),
      [],
      "no company left with an unread backlog"
    );
    // Every company was actually visited, not just the same three.
    assert.equal(new Set(syncCalls.map((s) => s.companyId)).size, 8);
  });

  it("visits the company that is furthest behind first", async () => {
    world = [company("small", 1), company("huge", 500), company("medium", 50)];

    await cron({ maxCompanies: 1 });

    assert.deepEqual(
      syncCalls.map((s) => s.companyId),
      ["huge"]
    );
  });

  it("leaves companies that are already covered for the day alone", async () => {
    world = [company("covered", 0, 30), company("behind", 12)];

    const summary = await cron();

    // Nothing pending means nothing to ask Buffer, so a second or third run in the
    // same day costs a covered company exactly zero requests.
    assert.deepEqual(
      syncCalls.map((s) => s.companyId),
      ["behind"]
    );
    assert.equal(summary.postsRead, 12);
    assert.equal(summary.remaining, 0);
  });
});

describe("runAnalyticsCron — rate-limit safety", () => {
  beforeEach(() => {
    world = [company("busy", 500)];
  });

  it("never lets one company exceed its daily request budget", async () => {
    // Four runs in one day against a backlog far larger than the budget.
    for (let i = 0; i < 4; i++) {
      await cron({ perCompanyLimit: 100, dailyBudget: 200 });
    }

    const requests = syncCalls.reduce((sum, call) => sum + Math.min(call.limit, 500), 0);
    assert.ok(requests <= 200, `spent ${requests} requests, budget is 200`);
    assert.equal(world[0].readToday, 200);
    // The rest is deferred, not lost — tomorrow's runs continue from there.
    assert.equal(world[0].pending, 300);
  });

  it("reports a budget-exhausted company instead of silently skipping it", async () => {
    world = [company("busy", 100, 200)];

    const summary = await cron({ dailyBudget: 200 });

    assert.equal(summary.budgetExhausted, 1);
    assert.deepEqual(syncCalls, [], "no request is made once the day's budget is gone");
  });

  it("asks for only what is left of the budget, not a full batch", async () => {
    world = [company("busy", 100, 180)];

    await cron({ perCompanyLimit: 100, dailyBudget: 200 });

    assert.deepEqual(syncCalls, [{ companyId: "busy", limit: 20 }]);
  });
});

describe("runAnalyticsCron — isolation and interruption", () => {
  it("keeps going when one company's sync throws", async () => {
    world = [company("bad", 10), company("good", 5)];

    const summary = await cron({
      sync: async (options) => {
        if (options.companyId === "bad") throw new Error("Buffer unreachable");
        return fakeSync(options);
      },
    });

    assert.equal(summary.failed, 1);
    assert.equal(summary.processed, 1);
    assert.deepEqual(summary.companyFailures, [{ slug: "bad", message: "Buffer unreachable" }]);
    // The healthy company still got its refresh.
    assert.equal(world.find((c) => c.id === "good")?.pending, 0);
  });

  it("stops claiming companies at the deadline and marks the run interrupted", async () => {
    world = Array.from({ length: 5 }, (_, i) => company(`c${i + 1}`, 10));

    // A clock that jumps a minute per read, against a one-minute budget.
    let clock = 0;
    const summary = await cron({
      now: () => new Date(clock),
      timeBudgetMs: 60_000,
      sync: async (options) => {
        clock += 60_000;
        return fakeSync(options);
      },
    });

    assert.equal(summary.timedOut, true);
    assert.equal(summary.examined, 1);
    // Untouched companies keep their whole backlog pending, so the next run picks
    // them up first — nothing is consumed by a run that could not reach them.
    assert.equal(world.filter((c) => c.pending === 10).length, 4);
  });

  it("propagates a sync that stopped mid-company as an interrupted run", async () => {
    world = [company("c1", 40)];

    const summary = await cron({
      sync: async (options) => ({ ...(await fakeSync(options)), stoppedEarly: true }),
    });

    assert.equal(summary.timedOut, true);
  });

  it("records a failed selection as a failed run rather than a silent success", async () => {
    world = [];

    const summary = await cron({
      selectCompanies: async () => {
        throw new Error("database down");
      },
    });

    assert.equal(summary.status, "failed");
    assert.equal(summary.error, "database down");
  });
});
