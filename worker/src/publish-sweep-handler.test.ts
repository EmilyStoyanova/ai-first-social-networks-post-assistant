import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createLogger } from "./logger";
import {
  createPublishSweepHandler,
  toDiagnostics,
  PUBLISH_SWEEP_JOB_TYPE,
} from "./publish-sweep-handler";
import type { JobRecord } from "./job-store";
import type { PublishCronSummary } from "@/lib/services/cron/run-publish-cron.service";

const silentLogger = createLogger("test", () => {});

function summary(overrides: Partial<PublishCronSummary> = {}): PublishCronSummary {
  return {
    runId: "run-1",
    status: "completed",
    kind: "publish",
    examined: 3,
    processed: 3,
    failed: 0,
    published: 5,
    failedPosts: 0,
    skipped: 0,
    pastDue: 0,
    remaining: 0,
    durationMs: 1200,
    companies: [],
    companyFailures: [],
    timedOut: false,
    ...overrides,
  };
}

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "j1",
    type: PUBLISH_SWEEP_JOB_TYPE,
    payload: {},
    attempts: 1,
    maxAttempts: 5,
    result: null,
    ...overrides,
  };
}

describe("toDiagnostics", () => {
  it("surfaces the two numbers that mean the cadence is wrong", () => {
    const d = toDiagnostics(summary({ remaining: 4, pastDue: 6, timedOut: true }));

    // remainingCompanies: the sweep is undersized. pastDuePosts: posts are missing
    // their slots by more than the 90-minute grace, which at a 30-minute cadence
    // means something upstream is not running at all.
    assert.equal(d.remainingCompanies, 4);
    assert.equal(d.pastDuePosts, 6);
    assert.equal(d.timedOut, true);
    assert.equal(d.publishedPosts, 5);
  });
});

describe("publishSweepHandler", () => {
  it("delegates to the existing cron service exactly once", async () => {
    // Once per job is the whole idempotency story at this layer: a handler that
    // ran the sweep twice would deliver every due post twice.
    let calls = 0;
    const handler = createPublishSweepHandler(async () => {
      calls++;
      return summary();
    });

    await handler({ job: job(), logger: silentLogger });
    assert.equal(calls, 1);
  });

  it("throws when the run fails at the top level (so the queue retries)", async () => {
    // A top-level failure is a sweep that published nothing — safe to retry.
    const handler = createPublishSweepHandler(async () =>
      summary({ status: "failed", error: "database unavailable", published: 0 })
    );
    await assert.rejects(
      () => handler({ job: job(), logger: silentLogger }),
      /database unavailable/
    );
  });

  it("does NOT retry a completed sweep that had per-company failures", async () => {
    // The important one. Retrying would re-run the sweep for EVERY company,
    // including the ones whose posts were delivered successfully — turning a
    // handled failure into duplicate delivery.
    const handler = createPublishSweepHandler(async () =>
      summary({
        status: "completed",
        failed: 1,
        published: 4,
        companyFailures: [{ slug: "acme", message: "token expired" }],
      })
    );
    await assert.doesNotReject(() => handler({ job: job(), logger: silentLogger }));
  });

  it("does NOT retry per-post delivery failures", async () => {
    // Those have their own retry step with its own backoff budget
    // (retryFailedPosts); re-sweeping is the wrong instrument.
    const handler = createPublishSweepHandler(async () =>
      summary({ status: "completed", published: 3, failedPosts: 2 })
    );
    await assert.doesNotReject(() => handler({ job: job(), logger: silentLogger }));
  });

  it("does NOT retry a sweep that merely left a backlog", async () => {
    // The next tick is 30 minutes away and re-derives what is due. Retrying now
    // would re-visit the companies this run already published for.
    const handler = createPublishSweepHandler(async () =>
      summary({ status: "completed", timedOut: true, remaining: 9, published: 10 })
    );
    await assert.doesNotReject(() => handler({ job: job(), logger: silentLogger }));
  });

  it("does NOT retry a sweep that parked past-due posts", async () => {
    // Parking is a decision, not an error: those posts need a person, not another
    // delivery attempt.
    const handler = createPublishSweepHandler(async () =>
      summary({ status: "completed", pastDue: 3, published: 0 })
    );
    await assert.doesNotReject(() => handler({ job: job(), logger: silentLogger }));
  });

  it("returns the diagnostics the queue persists as the job result", async () => {
    const handler = createPublishSweepHandler(async () => summary({ published: 7 }));

    const result = await handler({ job: job(), logger: silentLogger });

    assert.equal((result as { publishedPosts: number }).publishedPosts, 7);
    assert.equal((result as { runId: string }).runId, "run-1");
  });
});
