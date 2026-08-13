import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bulkPollIntervalMs,
  committedPostCount,
  isTerminalBulkJobPhase,
  resolveBulkJobPhase,
  summarizeBulkJob,
  toBulkBatchResponse,
  WAITING_FOR_WORKER_MS,
  type BulkJobProgress,
  type BulkJobStatus,
} from "./bulk-job";

const CREATED = "2026-08-13T10:00:00.000Z";
const CREATED_MS = Date.parse(CREATED);

function status(overrides: Partial<BulkJobStatus> = {}): BulkJobStatus {
  return {
    jobId: "job-1",
    state: "queued",
    attempts: 1,
    maxAttempts: 3,
    createdAt: CREATED,
    startedAt: null,
    finishedAt: null,
    progress: null,
    lastError: null,
    ...overrides,
  };
}

describe("resolveBulkJobPhase", () => {
  it("reads a freshly queued job as queued", () => {
    assert.equal(resolveBulkJobPhase(status(), CREATED_MS + 5_000), "queued");
  });

  it("says a job is waiting for a worker once it has waited long enough", () => {
    // The state that means "no worker claimed this" — worth naming, because a
    // permanent production worker is not deployed yet and an unexplained
    // spinner would read as broken generation.
    assert.equal(
      resolveBulkJobPhase(status(), CREATED_MS + WAITING_FOR_WORKER_MS),
      "waiting-for-worker"
    );
    assert.equal(resolveBulkJobPhase(status(), CREATED_MS + 600_000), "waiting-for-worker");
  });

  it("measures the wait from when the job was created, not from when polling started", () => {
    // A job restored from session storage after a navigation must be judged on
    // how long it has really waited.
    const old = status({ createdAt: "2026-08-13T09:00:00.000Z" });
    assert.equal(resolveBulkJobPhase(old, CREATED_MS), "waiting-for-worker");
  });

  it("honours a caller-supplied threshold", () => {
    assert.equal(resolveBulkJobPhase(status(), CREATED_MS + 5_000, 1_000), "waiting-for-worker");
  });

  it("passes every other state through unchanged", () => {
    for (const state of ["running", "completed", "failed", "cancelled"] as const) {
      assert.equal(resolveBulkJobPhase(status({ state }), CREATED_MS + 600_000), state);
    }
  });

  it("reads a requeued job as queued again, not as running", () => {
    // A failed attempt waiting to be retried has a startedAt from the earlier
    // one, but it is once more waiting for a worker to claim it.
    const requeued = status({ state: "queued", startedAt: CREATED, lastError: "boom" });
    assert.equal(resolveBulkJobPhase(requeued, CREATED_MS + 1_000), "queued");
  });

  it("stays queued rather than guessing when the timestamp is unreadable", () => {
    assert.equal(resolveBulkJobPhase(status({ createdAt: "nonsense" }), CREATED_MS), "queued");
  });
});

describe("isTerminalBulkJobPhase / bulkPollIntervalMs", () => {
  it("stops polling once the job has finished, one way or another", () => {
    for (const phase of ["completed", "failed", "cancelled"] as const) {
      assert.equal(isTerminalBulkJobPhase(phase), true);
      assert.equal(bulkPollIntervalMs(phase), 0);
    }
  });

  it("keeps polling while there is anything left to happen", () => {
    for (const phase of ["queued", "waiting-for-worker", "running"] as const) {
      assert.equal(isTerminalBulkJobPhase(phase), false);
      assert.ok(bulkPollIntervalMs(phase) > 0);
    }
  });

  it("polls a running job more often than one that is merely waiting", () => {
    assert.ok(bulkPollIntervalMs("running") < bulkPollIntervalMs("waiting-for-worker"));
  });
});

describe("summarizeBulkJob", () => {
  it("reports zeros against the requested total before any progress exists", () => {
    // The denominator has to be right on the first render, when a 202 has
    // arrived and nothing has been written.
    assert.deepEqual(summarizeBulkJob(null, 5), {
      completedTopics: 0,
      totalTopics: 5,
      generatedPosts: 0,
      failedChannels: 0,
    });
  });

  it("counts committed topics and posts from the groups", () => {
    const progress: BulkJobProgress = {
      batchId: "b1",
      requested: 5,
      generated: 3,
      generatedPosts: 9,
      groups: [
        {
          index: 1,
          contentGroupId: "g1",
          posts: [p(1, "FACEBOOK"), p(1, "LINKEDIN"), p(1, "INSTAGRAM")],
        },
        {
          index: 2,
          contentGroupId: "g2",
          posts: [p(2, "FACEBOOK"), p(2, "LINKEDIN"), p(2, "INSTAGRAM")],
        },
        {
          index: 3,
          contentGroupId: "g3",
          posts: [p(3, "FACEBOOK"), p(3, "LINKEDIN"), p(3, "INSTAGRAM")],
        },
      ],
    };

    assert.deepEqual(summarizeBulkJob(progress, 5), {
      completedTopics: 3,
      totalTopics: 5,
      generatedPosts: 9,
      failedChannels: 0,
    });
  });

  it("counts a partial topic as finished and reports its failed channels", () => {
    // Facebook and Instagram were written, LinkedIn was not. The topic is done;
    // the missing channel is reported rather than hidden.
    const progress: BulkJobProgress = {
      batchId: "b1",
      requested: 1,
      generated: 1,
      groups: [
        {
          index: 1,
          contentGroupId: "g1",
          posts: [p(1, "FACEBOOK"), p(1, "INSTAGRAM")],
          failures: [{ channel: "LINKEDIN", code: "CANNOT_GENERATE_UNIQUE_POST" }],
        },
      ],
    };

    assert.deepEqual(summarizeBulkJob(progress, 1), {
      completedTopics: 1,
      totalTopics: 1,
      generatedPosts: 2,
      failedChannels: 1,
    });
  });

  it("does not double-count failures a finished summary records in both places", () => {
    const progress: BulkJobProgress = {
      batchId: "b1",
      requested: 1,
      generated: 1,
      groups: [
        {
          index: 1,
          contentGroupId: "g1",
          posts: [p(1, "FACEBOOK")],
          failures: [{ channel: "LINKEDIN", code: "X" }],
        },
      ],
      failures: [{ channel: "LINKEDIN", code: "X" }],
    };

    assert.equal(summarizeBulkJob(progress, 1).failedChannels, 1);
  });

  it("falls back to the flat counters when no groups were recorded", () => {
    const progress: BulkJobProgress = {
      batchId: "b1",
      requested: 4,
      generated: 2,
      generatedPosts: 2,
      failures: [{ channel: "FACEBOOK", code: "X" }],
    };

    assert.deepEqual(summarizeBulkJob(progress, 4), {
      completedTopics: 2,
      totalTopics: 4,
      generatedPosts: 2,
      failedChannels: 1,
    });
  });

  it("prefers the run's own requested total over what the form asked for", () => {
    const progress: BulkJobProgress = { batchId: "b1", requested: 5, generated: 0 };
    assert.equal(summarizeBulkJob(progress, 99).totalTopics, 5);
  });
});

describe("committedPostCount", () => {
  it("is zero before anything is written", () => {
    assert.equal(committedPostCount(null), 0);
    assert.equal(committedPostCount({ batchId: "b", requested: 3, generated: 0 }), 0);
  });

  it("counts the posts across every group", () => {
    assert.equal(
      committedPostCount({
        batchId: "b",
        requested: 2,
        generated: 2,
        groups: [
          { index: 1, contentGroupId: "g1", posts: [p(1, "FACEBOOK"), p(1, "LINKEDIN")] },
          { index: 2, contentGroupId: "g2", posts: [p(2, "FACEBOOK")] },
        ],
      }),
      3
    );
  });

  it("reads a finished summary's post ids when it has no groups", () => {
    assert.equal(
      committedPostCount({ batchId: "b", requested: 1, generated: 1, postIds: ["p1", "p2"] }),
      2
    );
  });
});

describe("toBulkBatchResponse", () => {
  it("has nothing to show for a job that committed nothing", () => {
    assert.equal(toBulkBatchResponse(null), null);
  });

  it("passes a finished summary through as the panel's own shape", () => {
    const batch = toBulkBatchResponse({
      batchId: "b1",
      requested: 3,
      generated: 2,
      failed: 1,
      postIds: ["p1", "p2"],
      posts: [
        { index: 1, postId: "p1", scheduledFor: "2026-08-20T09:00:00.000Z" },
        { index: 2, postId: "p2", scheduledFor: "2026-08-21T09:00:00.000Z" },
      ],
      failures: [
        {
          index: 3,
          scheduledFor: "2026-08-22T09:00:00.000Z",
          channel: "LINKEDIN",
          code: "NO_FEED_ITEMS_AVAILABLE",
          reason: "no_eligible_content",
          message: "nothing left",
        },
      ],
      notAttempted: 0,
      stoppedEarly: true,
      stopReason: "generation_failed",
      exhaustedSources: [null],
    });

    assert.ok(batch);
    assert.equal(batch.batchId, "b1");
    assert.equal(batch.generated, 2);
    assert.equal(batch.failed, 1);
    assert.equal(batch.stopReason, "generation_failed");
    assert.deepEqual(batch.exhaustedSources, [null]);
    assert.equal(batch.failures[0].reason, "no_eligible_content");
  });

  it("builds the flat lists from the groups when only they were recorded", () => {
    // A mid-flight snapshot that the job then completed on: the panel still has
    // to be able to read it.
    const batch = toBulkBatchResponse({
      batchId: "b1",
      requested: 2,
      generated: 2,
      groups: [
        { index: 1, contentGroupId: "g1", posts: [p(1, "FACEBOOK"), p(1, "LINKEDIN")] },
        {
          index: 2,
          contentGroupId: "g2",
          posts: [p(2, "FACEBOOK")],
          failures: [{ channel: "LINKEDIN", code: "X", reason: "provider_error" }],
        },
      ],
    });

    assert.ok(batch);
    assert.equal(batch.posts.length, 3);
    assert.deepEqual(
      batch.postIds,
      batch.posts.map((x) => x.postId)
    );
    assert.equal(batch.failures.length, 1);
    assert.equal(batch.failures[0].reason, "provider_error");
  });

  it("drops a stop reason the panel has no wording for", () => {
    // Rather than passing an unknown string through to a translation lookup
    // that would throw in place of the summary.
    const batch = toBulkBatchResponse({
      batchId: "b1",
      requested: 1,
      generated: 1,
      stopReason: "something_new",
    });
    assert.equal(batch?.stopReason, null);
  });

  it("derives the failed count when the summary did not record one", () => {
    const batch = toBulkBatchResponse({ batchId: "b1", requested: 5, generated: 2 });
    assert.equal(batch?.failed, 3);
  });
});

/** A committed post inside a group, with the fields the helpers read. */
function p(index: number, channel: string) {
  return {
    index,
    postId: `p${index}-${channel}`,
    channel,
    scheduledFor: "2026-08-20T09:00:00.000Z",
  };
}
