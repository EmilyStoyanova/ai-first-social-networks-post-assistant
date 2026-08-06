import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createLogger } from "./logger";
import {
  createAnalyticsSyncHandler,
  toDiagnostics,
  ANALYTICS_SYNC_JOB_TYPE,
} from "./analytics-sync-handler";
import type { JobRecord } from "./job-store";
import type { AnalyticsCronSummary } from "@/lib/services/cron/run-analytics-cron.service";

const silentLogger = createLogger("test", () => {});

function summary(overrides: Partial<AnalyticsCronSummary> = {}): AnalyticsCronSummary {
  return {
    runId: "run-1",
    status: "completed",
    kind: "analytics",
    examined: 3,
    processed: 3,
    failed: 0,
    budgetExhausted: 0,
    postsRead: 120,
    postsUpdated: 118,
    remaining: 0,
    durationMs: 4200,
    companies: [],
    companyFailures: [],
    timedOut: false,
    ...overrides,
  };
}

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "j1",
    type: ANALYTICS_SYNC_JOB_TYPE,
    payload: {},
    attempts: 1,
    maxAttempts: 5,
    ...overrides,
  };
}

describe("toDiagnostics", () => {
  it("surfaces the backlog an operator needs to watch", () => {
    const d = toDiagnostics(summary({ remaining: 340, timedOut: true }));

    // remainingPosts is the coverage signal: a number that never reaches zero
    // means the schedule or the daily budget is too tight for this many posts.
    assert.equal(d.remainingPosts, 340);
    assert.equal(d.timedOut, true);
    assert.equal(d.postsRead, 120);
    assert.equal(d.postsUpdated, 118);
  });
});

describe("analyticsSyncHandler", () => {
  it("delegates to the existing cron service exactly once", async () => {
    let calls = 0;
    const handler = createAnalyticsSyncHandler(async () => {
      calls++;
      return summary();
    });

    await handler({ job: job(), logger: silentLogger });
    assert.equal(calls, 1);
  });

  it("throws when the run fails at the top level (so the queue retries)", async () => {
    const handler = createAnalyticsSyncHandler(async () =>
      summary({ status: "failed", error: "database unavailable" })
    );
    await assert.rejects(
      () => handler({ job: job(), logger: silentLogger }),
      /database unavailable/
    );
  });

  it("does NOT retry a completed run that merely left a backlog", async () => {
    // An unfinished backlog is the normal continuation signal — the next scheduled
    // run picks it up. Retrying would re-read what already succeeded and spend
    // Buffer's daily allowance twice.
    const handler = createAnalyticsSyncHandler(async () =>
      summary({ status: "completed", timedOut: true, remaining: 500 })
    );
    await assert.doesNotReject(() => handler({ job: job(), logger: silentLogger }));
  });

  it("does NOT retry isolated per-company failures", async () => {
    const handler = createAnalyticsSyncHandler(async () =>
      summary({
        status: "completed",
        failed: 1,
        companyFailures: [{ slug: "acme", message: "boom" }],
      })
    );
    await assert.doesNotReject(() => handler({ job: job(), logger: silentLogger }));
  });
});
