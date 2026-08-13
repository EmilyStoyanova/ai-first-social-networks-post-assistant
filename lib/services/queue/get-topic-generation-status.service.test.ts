import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getTopicGenerationStatus,
  type GetTopicGenerationStatusDeps,
} from "./get-topic-generation-status.service";
import type { JobRow } from "./job-status";
import { TOPIC_GENERATION_JOB_TYPE } from "@/lib/queue/job-types";
import type { JobStatus } from "@prisma/client";

const SLUG = "acme";
const JOB_ID = "job-1";
const USER_ID = "user-1";
const COMPANY_ID = "company-1";

interface RecordedLookup {
  jobId: string;
  companyId: string;
  type: string;
}

function row(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: JOB_ID,
    status: "active" as JobStatus,
    attempts: 1,
    maxAttempts: 2,
    createdAt: new Date("2026-08-12T10:00:00.000Z"),
    startedAt: new Date("2026-08-12T10:00:05.000Z"),
    finishedAt: null,
    result: null,
    lastError: null,
    ...overrides,
  };
}

function makeDeps(options: { access?: { companyId: string } | null; job?: JobRow | null } = {}): {
  deps: GetTopicGenerationStatusDeps;
  lookups: () => RecordedLookup[];
} {
  const lookups: RecordedLookup[] = [];
  const deps: GetTopicGenerationStatusDeps = {
    resolveAccess: async () =>
      options.access === undefined ? { companyId: COMPANY_ID } : options.access,
    findJob: async (jobId, companyId, type) => {
      lookups.push({ jobId, companyId, type });
      return options.job === undefined ? row() : options.job;
    },
  };
  return { deps, lookups: () => lookups };
}

describe("getTopicGenerationStatus — scoping", () => {
  it("looks the job up by company AND by type", async () => {
    const { deps, lookups } = makeDeps();

    await getTopicGenerationStatus(SLUG, JOB_ID, USER_ID, false, deps);

    // Both are part of the query, not a check afterwards: there is no moment at
    // which an out-of-scope row has been read. The type matters as much as the
    // company — a bulk id here must not return a bulk summary.
    assert.deepEqual(lookups(), [
      { jobId: JOB_ID, companyId: COMPANY_ID, type: TOPIC_GENERATION_JOB_TYPE },
    ]);
  });

  it("answers NOT_FOUND for a company the user is not a member of", async () => {
    const { deps, lookups } = makeDeps({ access: null });

    const result = await getTopicGenerationStatus(SLUG, JOB_ID, USER_ID, false, deps);

    assert.equal(result.success, false);
    assert.equal(lookups().length, 0);
  });

  it("answers NOT_FOUND rather than confirming another company's job exists", async () => {
    const { deps } = makeDeps({ job: null });

    const result = await getTopicGenerationStatus(SLUG, JOB_ID, USER_ID, false, deps);

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, "NOT_FOUND");
  });
});

describe("getTopicGenerationStatus — what the run is doing", () => {
  const cases: Array<[JobStatus, string]> = [
    ["queued", "queued"],
    ["active", "running"],
    ["completed", "completed"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
  ];

  for (const [status, expected] of cases) {
    it(`maps ${status} to ${expected}`, async () => {
      const { deps } = makeDeps({ job: row({ status }) });

      const result = await getTopicGenerationStatus(SLUG, JOB_ID, USER_ID, false, deps);

      assert.equal(result.success, true);
      if (!result.success) return;
      assert.equal(result.data.state, expected);
    });
  }

  it("reads a requeued job as queued, not as still running", async () => {
    // It has a startedAt from its earlier attempt but is waiting for a worker
    // again, exactly like a fresh one.
    const { deps } = makeDeps({
      job: row({ status: "queued", attempts: 2, lastError: "worker died" }),
    });

    const result = await getTopicGenerationStatus(SLUG, JOB_ID, USER_ID, false, deps);

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.data.state, "queued");
    // The earlier failure is kept: hiding it would make the wait look like the
    // first one.
    assert.equal(result.data.lastError, "worker died");
  });
});

describe("getTopicGenerationStatus — progress", () => {
  it("returns the committed channels with their posts", async () => {
    const { deps } = makeDeps({
      job: row({
        result: {
          contentGroupId: "group-1",
          channels: ["linkedin", "facebook"],
          posts: [{ channel: "linkedin", postId: "post-1", post: { id: "post-1" } }],
          failures: [],
          notAttempted: [],
        },
      }),
    });

    const result = await getTopicGenerationStatus(SLUG, JOB_ID, USER_ID, false, deps);

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.data.progress?.posts.length, 1);
    // The whole post travels, which is what lets the grid add a card per poll.
    assert.deepEqual(result.data.progress?.posts[0].post, { id: "post-1" });
    assert.deepEqual(result.data.progress?.channels, ["linkedin", "facebook"]);
  });

  it("reads as no progress when the record cannot be parsed", async () => {
    // An arbitrary blob, shaped by whatever last wrote to the column, must not
    // cross back out to a browser.
    const { deps } = makeDeps({ job: row({ result: { unexpected: true } }) });

    const result = await getTopicGenerationStatus(SLUG, JOB_ID, USER_ID, false, deps);

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.data.progress, null);
  });

  it("is null before the run has recorded anything", async () => {
    const { deps } = makeDeps({ job: row({ result: null }) });

    const result = await getTopicGenerationStatus(SLUG, JOB_ID, USER_ID, false, deps);

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.data.progress, null);
  });
});
