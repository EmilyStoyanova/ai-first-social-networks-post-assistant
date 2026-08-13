import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createBulkGenerationHandler,
  toResumeState,
  BULK_GENERATION_JOB_TYPE,
} from "./bulk-generation-handler";
import type { JobRecord } from "./job-store";
import type { Logger } from "./logger";
import type { BulkGenerationSummary } from "@/lib/services/ai/bulk-generate-posts.service";

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** The handler's return value read back as the summary it is. */
function asSummary(result: unknown): BulkGenerationSummary {
  return result as BulkGenerationSummary;
}

const SLUG = "acme";
const USER_ID = "user-1";
const BATCH_ID = "batch-1";

/** A well-formed payload, with the plan already minted onto it. */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: SLUG,
    userId: USER_ID,
    batchId: BATCH_ID,
    contentGroupIds: ["group-1", "group-2"],
    channels: ["linkedin", "facebook"],
    numberOfPosts: 2,
    startDate: "2026-08-17",
    endDate: "2026-08-30",
    ...overrides,
  };
}

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    type: BULK_GENERATION_JOB_TYPE,
    payload: payload(),
    attempts: 1,
    maxAttempts: 3,
    result: null,
    ...overrides,
  };
}

/** A summary shaped as the service builds one. */
function summary(overrides: Partial<BulkGenerationSummary> = {}): BulkGenerationSummary {
  return {
    batchId: BATCH_ID,
    requested: 2,
    generated: 2,
    failed: 0,
    channels: ["linkedin", "facebook"],
    requestedPosts: 4,
    generatedPosts: 4,
    groups: [],
    postIds: [],
    posts: [],
    failures: [],
    notAttempted: 0,
    stoppedEarly: false,
    stopReason: null,
    exhaustedSources: [],
    ...overrides,
  };
}

// ─── Delegation ───────────────────────────────────────────────────────────────

describe("bulk generation handler — delegation", () => {
  it("hands the payload's request to the service unchanged", async () => {
    let seen: unknown = null;
    const handler = createBulkGenerationHandler({
      resolveRequester: async () => ({ isGlobalAdmin: false }),
      generate: async (slug, userId, isGlobalAdmin, input) => {
        seen = { slug, userId, isGlobalAdmin, input };
        return { success: true, data: summary() };
      },
    });

    await handler({ job: job(), logger: silentLogger });

    assert.deepEqual(seen, {
      slug: SLUG,
      userId: USER_ID,
      isGlobalAdmin: false,
      input: {
        channels: ["linkedin", "facebook"],
        numberOfPosts: 2,
        startDate: "2026-08-17",
        endDate: "2026-08-30",
        customDistribution: undefined,
        contentLanguage: undefined,
        includeSourceLinkOverride: undefined,
        autoGenerateImageOverride: undefined,
        llmConfigId: undefined,
        // The raw dropdown value is parsed the same way the single-post route
        // parses it; absent means the pooled default.
        contentSource: { kind: "company_rules" },
        sourceMix: undefined,
      },
    });
  });

  it("uses the payload's batch and group ids rather than minting its own", async () => {
    const groupIds: string[] = [];
    let batchId: string | null = null;

    const handler = createBulkGenerationHandler({
      resolveRequester: async () => ({ isGlobalAdmin: false }),
      generate: async (_slug, _userId, _isGlobalAdmin, _input, deps = {}) => {
        batchId = deps.newBatchId?.() ?? null;
        groupIds.push(deps.newContentGroupId?.() ?? "");
        groupIds.push(deps.newContentGroupId?.() ?? "");
        return { success: true, data: summary() };
      },
    });

    await handler({ job: job(), logger: silentLogger });

    // Both are decided at enqueue and travel in the payload, so attempt 2 writes
    // into the same batch and re-opens the same groups.
    assert.equal(batchId, BATCH_ID);
    assert.deepEqual(groupIds, ["group-1", "group-2"]);
  });

  it("passes the worker's own budget, not the HTTP route's", async () => {
    let budget: number | undefined;
    const handler = createBulkGenerationHandler({
      resolveRequester: async () => ({ isGlobalAdmin: false }),
      bulkBudgetMs: 1_800_000,
      generate: async (_s, _u, _a, _i, deps = {}) => {
        budget = deps.softBudgetMs;
        return { success: true, data: summary() };
      },
    });

    await handler({ job: job(), logger: silentLogger });

    assert.equal(budget, 1_800_000);
  });

  it("reports the service's progress through the job's progress seam", async () => {
    const reported: unknown[] = [];
    const handler = createBulkGenerationHandler({
      resolveRequester: async () => ({ isGlobalAdmin: false }),
      generate: async (_s, _u, _a, _i, deps = {}) => {
        await deps.onProgress?.(summary({ generated: 1, generatedPosts: 2 }));
        return { success: true, data: summary() };
      },
    });

    await handler({
      job: job(),
      logger: silentLogger,
      reportProgress: async (p) => {
        reported.push(p);
      },
    });

    assert.equal(reported.length, 1);
    assert.equal((reported[0] as BulkGenerationSummary).generated, 1);
  });
});

// ─── Authorization ────────────────────────────────────────────────────────────

describe("bulk generation handler — authorization at execution time", () => {
  it("reads the requester's admin rights now, not from the payload", async () => {
    let sawAdmin: boolean | null = null;
    const handler = createBulkGenerationHandler({
      // Promoted (or demoted) since the job was queued — this is the answer that
      // must be used, because it is the one true when the posts get written.
      resolveRequester: async () => ({ isGlobalAdmin: true }),
      generate: async (_slug, _userId, isGlobalAdmin) => {
        sawAdmin = isGlobalAdmin;
        return { success: true, data: summary() };
      },
    });

    await handler({ job: job(), logger: silentLogger });

    assert.equal(sawAdmin, true);
  });

  it("fails the job when the requester no longer exists", async () => {
    let ran = false;
    const handler = createBulkGenerationHandler({
      resolveRequester: async () => null,
      generate: async () => {
        ran = true;
        return { success: true, data: summary() };
      },
    });

    await assert.rejects(() => handler({ job: job(), logger: silentLogger }), /no longer exists/);
    assert.equal(ran, false);
  });
});

// ─── What is and is not retried ───────────────────────────────────────────────

describe("bulk generation handler — retry policy", () => {
  it("completes with a partial batch instead of throwing", async () => {
    const handler = createBulkGenerationHandler({
      resolveRequester: async () => ({ isGlobalAdmin: false }),
      generate: async () => ({
        success: true,
        data: summary({
          generated: 1,
          failed: 1,
          generatedPosts: 2,
          stoppedEarly: true,
          stopReason: "generation_failed",
          failures: [
            {
              index: 2,
              scheduledFor: new Date("2026-08-24T10:00:00.000Z"),
              code: "NO_FEED_ITEMS_AVAILABLE",
              reason: "no_eligible_content",
              message: "Nothing left.",
              channel: "linkedin",
            },
          ],
        }),
      }),
    });

    // The posts that exist are real and committed. Throwing would retry the whole
    // batch and write them all over again — and no per-channel failure here is
    // different a minute later.
    const result = await handler({ job: job(), logger: silentLogger });

    assert.equal(asSummary(result).stopReason, "generation_failed");
    assert.equal(asSummary(result).generated, 1);
  });

  it("completes when the run stopped on its time budget", async () => {
    const handler = createBulkGenerationHandler({
      resolveRequester: async () => ({ isGlobalAdmin: false }),
      generate: async () => ({
        success: true,
        data: summary({
          generated: 1,
          notAttempted: 1,
          stoppedEarly: true,
          stopReason: "time_budget",
        }),
      }),
    });

    const result = await handler({ job: job(), logger: silentLogger });
    assert.equal(asSummary(result).stopReason, "time_budget");
  });

  it("throws when nothing at all could be generated", async () => {
    const handler = createBulkGenerationHandler({
      resolveRequester: async () => ({ isGlobalAdmin: false }),
      generate: async () => ({ success: false, code: "NO_FEED_ITEMS_AVAILABLE" }),
    });

    // No post exists, so this is a failed job rather than an empty success.
    await assert.rejects(
      () => handler({ job: job(), logger: silentLogger }),
      /NO_FEED_ITEMS_AVAILABLE/
    );
  });

  it("throws on a payload it cannot understand", async () => {
    const handler = createBulkGenerationHandler({
      resolveRequester: async () => ({ isGlobalAdmin: false }),
      generate: async () => ({ success: true, data: summary() }),
    });

    await assert.rejects(
      () => handler({ job: job({ payload: { slug: SLUG } }), logger: silentLogger }),
      /Invalid bulk-generation payload/
    );
  });

  it("throws on a plan that does not have one group id per topic", async () => {
    const handler = createBulkGenerationHandler({
      resolveRequester: async () => ({ isGlobalAdmin: false }),
      generate: async () => ({ success: true, data: summary() }),
    });

    // A short list would silently leave the last topics unable to resume.
    await assert.rejects(
      () =>
        handler({
          job: job({ payload: payload({ contentGroupIds: ["group-1"] }) }),
          logger: silentLogger,
        }),
      /contentGroupIds/
    );
  });
});

// ─── Resumption ───────────────────────────────────────────────────────────────

describe("toResumeState", () => {
  it("finds nothing to resume on a first attempt", () => {
    assert.equal(toResumeState(null), undefined);
    assert.equal(toResumeState(undefined), undefined);
  });

  it("ignores a progress record it cannot parse", () => {
    // Starting over costs a regeneration; refusing to start would wedge the job.
    assert.equal(toResumeState({ nonsense: true }), undefined);
    assert.equal(toResumeState("not an object"), undefined);
  });

  it("rebuilds the groups and channels an earlier attempt committed", () => {
    const state = toResumeState({
      batchId: BATCH_ID,
      requested: 2,
      generated: 1,
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
            {
              index: 1,
              postId: "post-2",
              channel: "facebook",
              contentGroupId: "group-1",
              scheduledFor: "2026-08-18T12:00:00.000Z",
            },
          ],
        },
      ],
    });

    assert.ok(state);
    assert.equal(state.contentGroupIds[1], "group-1");
    assert.deepEqual(state.completedChannels[1], ["linkedin", "facebook"]);
    assert.equal(state.posts.length, 2);
    // Back to a real Date, so the resumed summary reads like the original.
    assert.equal(state.posts[0].scheduledFor.toISOString(), "2026-08-18T10:00:00.000Z");
  });

  it("picks up the topic that was mid-flight, with the topic it settled on", () => {
    const state = toResumeState({
      batchId: BATCH_ID,
      requested: 2,
      generated: 1,
      groups: [],
      liveTopic: {
        index: 2,
        contentGroupId: "group-2",
        completedChannels: ["linkedin"],
        anchor: {
          primaryFeedItemId: "article-9",
          coreMessage: "What this group is about.",
          topic: "topic-x",
          establishedBy: "linkedin",
        },
      },
    });

    assert.ok(state);
    // The channel it committed is skipped rather than written twice…
    assert.deepEqual(state.completedChannels[2], ["linkedin"]);
    assert.equal(state.contentGroupIds[2], "group-2");
    // …and the channels still missing continue THAT story instead of each
    // deciding a new one, which is what would fragment the group.
    assert.equal(state.anchors[2].primaryFeedItemId, "article-9");
    assert.equal(state.anchors[2].establishedBy, "linkedin");
  });

  it("does not double-count a live channel already recorded in its group", () => {
    const state = toResumeState({
      batchId: BATCH_ID,
      requested: 1,
      generated: 1,
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
      liveTopic: { index: 1, contentGroupId: "group-1", completedChannels: ["linkedin"] },
    });

    assert.ok(state);
    assert.deepEqual(state.completedChannels[1], ["linkedin"]);
  });

  it("hands the resume state to the service", async () => {
    let seen: unknown = null;
    const handler = createBulkGenerationHandler({
      resolveRequester: async () => ({ isGlobalAdmin: false }),
      generate: async (_s, _u, _a, _i, deps = {}) => {
        seen = deps.resume;
        return { success: true, data: summary() };
      },
    });

    await handler({
      job: job({
        attempts: 2,
        result: {
          batchId: BATCH_ID,
          requested: 2,
          generated: 1,
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
      logger: silentLogger,
    });

    assert.ok(seen);
    assert.deepEqual(
      (seen as { completedChannels: Record<number, string[]> }).completedChannels[1],
      ["linkedin"]
    );
  });
});
