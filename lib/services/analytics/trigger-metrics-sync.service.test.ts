import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { runForcedMetricsSync, FORCED_SYNC_LIMIT } from "./trigger-metrics-sync.service";
import type { SyncPostMetricsOptions, SyncPostMetricsSummary } from "./sync-post-metrics.service";

/**
 * Guards the contract the automatic first sync depends on: the forced path must
 * pass force=true.
 *
 * Without it, a key saved after that day's cron run would find every post
 * already "synced today" and import nothing. With no manual refresh to fall back
 * on, the owner would then stare at an empty analytics card until the next day's
 * cron — indistinguishable from the feature not working.
 */

let captured: SyncPostMetricsOptions[];

/** Stands in for syncPostMetrics, recording the options it was handed. */
async function fakeSync(options: SyncPostMetricsOptions): Promise<SyncPostMetricsSummary> {
  captured.push(options);
  return {
    skipped: false,
    examined: 0,
    updated: 0,
    noData: 0,
    forbidden: 0,
    notFound: 0,
    failed: 0,
    remaining: 0,
    stoppedEarly: false,
  };
}

beforeEach(() => {
  captured = [];
});

describe("runForcedMetricsSync", () => {
  it("forces the sync so the once-daily guard cannot suppress it", async () => {
    await runForcedMetricsSync("company-1", fakeSync);

    assert.equal(captured.length, 1);
    assert.equal(captured[0].force, true);
  });

  it("targets the company it was given", async () => {
    await runForcedMetricsSync("company-42", fakeSync);
    assert.equal(captured[0].companyId, "company-42");
  });

  it("uses the larger forced batch, not the cron's", async () => {
    await runForcedMetricsSync("company-1", fakeSync);
    assert.equal(captured[0].limit, FORCED_SYNC_LIMIT);
    // A forced run must cover more than the cron's per-run slice, or a first
    // import would still need several passes.
    assert.ok(FORCED_SYNC_LIMIT > 15);
  });

  it("passes the sync summary straight through", async () => {
    const result = await runForcedMetricsSync("company-1", async () => ({
      skipped: false,
      examined: 9,
      updated: 6,
      noData: 1,
      forbidden: 2,
      notFound: 0,
      failed: 0,
      remaining: 0,
      stoppedEarly: false,
    }));

    assert.equal(result.examined, 9);
    assert.equal(result.updated, 6);
    assert.equal(result.forbidden, 2);
  });
});
