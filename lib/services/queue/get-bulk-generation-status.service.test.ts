import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getBulkGenerationStatus,
  type GetBulkGenerationStatusDeps,
  type JobRow,
} from "./get-bulk-generation-status.service";
import type { JobStatus } from "@prisma/client";

const SLUG = "acme";
const JOB_ID = "job-1";
const USER_ID = "user-1";
const COMPANY_ID = "company-1";

function makeRow(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: JOB_ID,
    status: "active" as JobStatus,
    attempts: 1,
    maxAttempts: 3,
    createdAt: new Date("2026-08-12T09:00:00.000Z"),
    startedAt: new Date("2026-08-12T09:00:05.000Z"),
    finishedAt: null,
    result: null,
    lastError: null,
    ...overrides,
  };
}

/** Records exactly which (jobId, companyId) pair the service asked the DB for. */
function makeDeps(options: { access?: { companyId: string } | null; row?: JobRow | null } = {}): {
  deps: GetBulkGenerationStatusDeps;
  lookups: () => Array<[string, string]>;
} {
  const lookups: Array<[string, string]> = [];
  return {
    lookups: () => lookups,
    deps: {
      resolveAccess: async () =>
        options.access === undefined ? { companyId: COMPANY_ID } : options.access,
      findJob: async (jobId, companyId) => {
        lookups.push([jobId, companyId]);
        return options.row === undefined ? makeRow() : options.row;
      },
    },
  };
}

// ─── Scoping ──────────────────────────────────────────────────────────────────

describe("getBulkGenerationStatus — scoping", () => {
  it("looks the job up by company as well as by id", async () => {
    const { deps, lookups } = makeDeps();

    await getBulkGenerationStatus(SLUG, JOB_ID, USER_ID, false, deps);

    // The scoping is part of the query, so there is no moment at which an
    // out-of-scope row has been read. A uuid is not an access control.
    assert.deepEqual(lookups(), [[JOB_ID, COMPANY_ID]]);
  });

  it("answers NOT_FOUND for a company this user cannot see", async () => {
    const { deps, lookups } = makeDeps({ access: null });

    const result = await getBulkGenerationStatus(SLUG, JOB_ID, USER_ID, false, deps);

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, "NOT_FOUND");
    assert.equal(lookups().length, 0);
  });

  it("answers NOT_FOUND for a job belonging to another company", async () => {
    const { deps } = makeDeps({ row: null });

    const result = await getBulkGenerationStatus(SLUG, JOB_ID, USER_ID, false, deps);

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, "NOT_FOUND");
  });

  it("never returns the queue payload", async () => {
    const { deps } = makeDeps();

    const result = await getBulkGenerationStatus(SLUG, JOB_ID, USER_ID, false, deps);

    assert.equal(result.success, true);
    if (!result.success) return;
    // It holds the requester's id and the whole instruction; a status poll is not
    // the place to hand back the contents of a queue row.
    assert.equal("payload" in result.data, false);
  });
});

// ─── State ────────────────────────────────────────────────────────────────────

describe("getBulkGenerationStatus — what the run is doing", () => {
  const cases: Array<[JobStatus, string]> = [
    ["queued", "queued"],
    ["active", "running"],
    ["completed", "completed"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
  ];

  for (const [status, expected] of cases) {
    it(`maps ${status} to ${expected}`, async () => {
      const { deps } = makeDeps({ row: makeRow({ status }) });

      const result = await getBulkGenerationStatus(SLUG, JOB_ID, USER_ID, false, deps);

      assert.equal(result.success, true);
      if (!result.success) return;
      assert.equal(result.data.state, expected);
    });
  }

  it("still reads as queued after a failed attempt was requeued", async () => {
    const { deps } = makeDeps({
      row: makeRow({
        status: "queued",
        attempts: 1,
        startedAt: new Date("2026-08-12T09:00:05.000Z"),
        lastError: "lease expired — requeued by reaper",
      }),
    });

    const result = await getBulkGenerationStatus(SLUG, JOB_ID, USER_ID, false, deps);

    assert.equal(result.success, true);
    if (!result.success) return;
    // It has a startedAt from the earlier attempt but is not running now — it is
    // waiting for a worker, exactly like a fresh job.
    assert.equal(result.data.state, "queued");
    // And the reason for the wait is not hidden, or this would look like a first
    // attempt that had simply not been picked up yet.
    assert.equal(result.data.lastError, "lease expired — requeued by reaper");
    assert.equal(result.data.attempts, 1);
  });
});

// ─── Progress ─────────────────────────────────────────────────────────────────

describe("getBulkGenerationStatus — progress", () => {
  it("has no progress before the first topic commits", async () => {
    const { deps } = makeDeps({ row: makeRow({ result: null }) });

    const result = await getBulkGenerationStatus(SLUG, JOB_ID, USER_ID, false, deps);

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.data.progress, null);
  });

  it("returns the batch summary as far as it has got", async () => {
    const { deps } = makeDeps({
      row: makeRow({
        result: {
          batchId: "batch-1",
          requested: 3,
          generated: 1,
          generatedPosts: 2,
          channels: ["linkedin", "facebook"],
          groups: [
            {
              index: 1,
              contentGroupId: "group-1",
              posts: [
                {
                  index: 1,
                  postId: "post-1",
                  channel: "linkedin",
                  contentGroupId: "group-1",
                  scheduledFor: "2026-08-18T10:00:00.000Z",
                },
              ],
            },
          ],
        },
      }),
    });

    const result = await getBulkGenerationStatus(SLUG, JOB_ID, USER_ID, false, deps);

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.data.progress?.generated, 1);
    assert.equal(result.data.progress?.generatedPosts, 2);
    assert.equal(result.data.progress?.groups?.[0].posts[0].postId, "post-1");
  });

  it("reads an unparseable record as no progress rather than passing it through", async () => {
    const { deps } = makeDeps({ row: makeRow({ result: { unexpected: "shape" } }) });

    const result = await getBulkGenerationStatus(SLUG, JOB_ID, USER_ID, false, deps);

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.data.progress, null);
  });
});
