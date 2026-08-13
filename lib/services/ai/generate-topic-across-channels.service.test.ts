import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generateTopicAcrossChannels,
  type GenerateTopicInput,
  type TopicGenerationOutcome,
} from "./generate-topic-across-channels.service";
import type { GenerateDraftPostResult, GeneratedPostDTO } from "./generate-draft-post.service";
import { brandSetupOrigin } from "@/lib/posts/post-origin";

const SLUG = "acme";
const USER_ID = "user-1";
const GROUP_ID = "group-fixed";

/** Everything the orchestrator passed to ONE generation, as it received it. */
interface RecordedCall {
  channel: string;
  options: Record<string, unknown>;
}

function makeInput(overrides: Partial<GenerateTopicInput> = {}): GenerateTopicInput {
  return {
    slug: SLUG,
    userId: USER_ID,
    isGlobalAdmin: false,
    contentGroupId: GROUP_ID,
    channels: ["linkedin", "facebook", "instagram"],
    ...overrides,
  };
}

/**
 * A generated post, shaped the way the real generator returns one.
 *
 * `primaryFeedItemId` echoes the pin when the caller supplied one, so a fake
 * sibling reports back the same article it was told to write from — which is
 * what makes "every channel is on the same article" assertable here at all.
 */
function post(id: string, options: Record<string, unknown>): GeneratedPostDTO {
  return {
    id,
    companyId: "company-1",
    channel: "LINKEDIN",
    status: "DRAFT",
    text: "Generated",
    hashtags: [],
    imagePrompt: null,
    notes: null,
    llmProvider: "mock",
    llmModel: "mock",
    mediaUrl: null,
    sourceImageUrl: null,
    origin: brandSetupOrigin(),
    scheduledFor: (options.scheduledFor as Date | undefined) ?? null,
    generationBatchId: (options.generationBatchId as string | undefined) ?? null,
    contentGroupId: (options.contentGroupId as string | undefined) ?? null,
    primaryFeedItemId: (options.pinnedFeedItemId as string | undefined) ?? "article-1",
    coreMessage: "The one thing this topic says.",
    topic: "topic-a",
    createdAt: new Date("2026-08-10T00:00:00.000Z"),
  };
}

/**
 * A generation double driven by a per-channel script.
 *
 * Nothing about real generation is simulated — the reservation, the duplicate
 * gates and the LLM have their own tests. What is under test here is the two
 * decisions this layer owns: which generation settles the topic, and what every
 * channel after it is pinned to.
 */
function makeDeps(script: Record<string, GenerateDraftPostResult> = {}): {
  generate: NonNullable<Parameters<typeof generateTopicAcrossChannels>[1]>["generate"];
  calls: () => RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let n = 0;

  return {
    calls: () => calls,
    generate: async (_slug, channel, _userId, _isGlobalAdmin, opts = {}) => {
      calls.push({ channel, options: opts as Record<string, unknown> });
      const scripted = script[channel];
      if (scripted) return scripted;
      n += 1;
      return {
        success: true,
        post: post(`post-${n}`, opts as Record<string, unknown>),
        warnings: {
          duplicate: { flagged: false, similarityScore: null, matchedPostId: null },
        },
      } as GenerateDraftPostResult;
    },
  };
}

// ─── The anchor ───────────────────────────────────────────────────────────────

describe("generateTopicAcrossChannels — settling the topic", () => {
  it("writes one post per channel, all in the same content group", async () => {
    const { generate, calls } = makeDeps();

    const outcome = await generateTopicAcrossChannels(makeInput(), { generate });

    assert.equal(outcome.posts.length, 3);
    assert.equal(outcome.failures.length, 0);
    assert.deepEqual(
      outcome.posts.map((p) => p.channel),
      ["linkedin", "facebook", "instagram"]
    );
    for (const call of calls()) {
      assert.equal(call.options.contentGroupId, GROUP_ID);
    }
  });

  it("lets the first success decide the topic, and pins every channel after it", async () => {
    const { generate, calls } = makeDeps();

    const outcome = await generateTopicAcrossChannels(makeInput(), { generate });

    assert.equal(outcome.anchor?.establishedBy, "linkedin");
    assert.equal(outcome.anchor?.primaryFeedItemId, "article-1");

    // The anchoring call resolves its own source; it is not pinned to anything,
    // because there is nothing yet to pin it to.
    assert.equal(calls()[0].options.pinnedFeedItemId, undefined);
    assert.equal(calls()[0].options.sharedTopic, undefined);

    // Every channel after it writes from that same article, about that same claim.
    for (const call of calls().slice(1)) {
      assert.equal(call.options.pinnedFeedItemId, "article-1");
      assert.deepEqual(call.options.sharedTopic, {
        coreMessage: "The one thing this topic says.",
        topic: "topic-a",
        establishedBy: "linkedin",
      });
    }
  });

  it("resumes an anchor it was handed, so no channel re-decides the topic", async () => {
    const { generate, calls } = makeDeps();

    const outcome = await generateTopicAcrossChannels(
      makeInput({
        channels: ["facebook"],
        anchor: {
          primaryFeedItemId: "article-earlier",
          coreMessage: "What the first attempt settled on.",
          topic: "topic-earlier",
          establishedBy: "linkedin",
        },
      }),
      { generate }
    );

    // Even the FIRST call of this run is a sibling — the topic already exists.
    assert.equal(calls()[0].options.pinnedFeedItemId, "article-earlier");
    assert.equal(
      (calls()[0].options.sharedTopic as { coreMessage: string }).coreMessage,
      "What the first attempt settled on."
    );
    assert.equal(outcome.anchor?.establishedBy, "linkedin");
  });

  it("shares the topic without a pin when there is no article behind it", async () => {
    const { generate, calls } = makeDeps();

    await generateTopicAcrossChannels(
      makeInput({
        channels: ["facebook"],
        contentSource: { kind: "company_mission" },
        anchor: {
          // A mission/evergreen topic: real topic, no article to pin.
          primaryFeedItemId: null,
          coreMessage: "Why we do what we do.",
          topic: null,
          establishedBy: "linkedin",
        },
      }),
      { generate }
    );

    assert.equal(calls()[0].options.pinnedFeedItemId, undefined);
    assert.deepEqual(calls()[0].options.contentSource, { kind: "company_mission" });
    // Still constrained — otherwise a group of mission posts is three unrelated posts.
    assert.equal(
      (calls()[0].options.sharedTopic as { coreMessage: string }).coreMessage,
      "Why we do what we do."
    );
  });

  it("skips channels an earlier attempt already committed", async () => {
    const { generate, calls } = makeDeps();

    const outcome = await generateTopicAcrossChannels(
      makeInput({ alreadyGenerated: ["linkedin", "facebook"] }),
      { generate }
    );

    assert.deepEqual(
      calls().map((c) => c.channel),
      ["instagram"]
    );
    // Not regenerated, not reported as failures, and not counted as this run's posts.
    assert.equal(outcome.posts.length, 1);
    assert.equal(outcome.failures.length, 0);
  });

  it("gives each channel its own slot", async () => {
    const { generate, calls } = makeDeps();

    await generateTopicAcrossChannels(
      makeInput({
        channels: ["linkedin", "instagram"],
        scheduledFor: {
          linkedin: new Date("2026-08-17T09:00:00.000Z"),
          instagram: new Date("2026-08-17T18:00:00.000Z"),
        },
      }),
      { generate }
    );

    assert.equal(
      (calls()[0].options.scheduledFor as Date).toISOString(),
      "2026-08-17T09:00:00.000Z"
    );
    assert.equal(
      (calls()[1].options.scheduledFor as Date).toISOString(),
      "2026-08-17T18:00:00.000Z"
    );
  });
});

// ─── The company ──────────────────────────────────────────────────────────────

describe("generateTopicAcrossChannels — the company it wrote for", () => {
  it("carries the company out of the first generation that succeeded", async () => {
    const { generate } = makeDeps();

    const outcome = await generateTopicAcrossChannels(makeInput(), { generate });

    // Read from the post, never looked up again — a second query is a chance for
    // the batch record and the posts to disagree about where they landed.
    assert.equal(outcome.companyId, "company-1");
  });

  it("reports no company when every channel failed", async () => {
    const { generate } = makeDeps({
      linkedin: { success: false, code: "NO_FEED_ITEMS_AVAILABLE" },
      facebook: { success: false, code: "NO_FEED_ITEMS_AVAILABLE" },
      instagram: { success: false, code: "NO_FEED_ITEMS_AVAILABLE" },
    });

    const outcome = await generateTopicAcrossChannels(makeInput(), { generate });

    assert.equal(outcome.companyId, null);
    assert.equal(outcome.posts.length, 0);
  });
});

// ─── Failures ─────────────────────────────────────────────────────────────────

describe("generateTopicAcrossChannels — when a channel fails", () => {
  it("keeps the channels that worked and reports the one that did not", async () => {
    const { generate } = makeDeps({
      facebook: { success: false, code: "POST_TOO_LONG_WITH_URL", message: "Too long." },
    });

    const outcome = await generateTopicAcrossChannels(makeInput(), { generate });

    // A partial group is a real outcome: two committed drafts plus an honest
    // account of the third, not a reason to discard the two.
    assert.deepEqual(
      outcome.posts.map((p) => p.channel),
      ["linkedin", "instagram"]
    );
    assert.equal(outcome.failures.length, 1);
    assert.equal(outcome.failures[0].channel, "facebook");
    assert.equal(outcome.failures[0].code, "POST_TOO_LONG_WITH_URL");
  });

  it("lets the next channel settle the topic when the first one failed", async () => {
    const { generate, calls } = makeDeps({
      linkedin: { success: false, code: "LLM_PROVIDER_ERROR" },
    });

    const outcome = await generateTopicAcrossChannels(makeInput(), { generate });

    assert.equal(outcome.anchor?.establishedBy, "facebook");
    // Facebook anchored, so it resolved its own source; instagram is its sibling.
    assert.equal(calls()[1].options.pinnedFeedItemId, undefined);
    assert.equal(calls()[2].options.pinnedFeedItemId, "article-1");
  });

  it("carries a rate limit's retry hint through untouched", async () => {
    const { generate } = makeDeps({
      facebook: { success: false, code: "LLM_RATE_LIMITED", retryAfterMs: 30_000 },
    });

    const outcome = await generateTopicAcrossChannels(makeInput(), { generate });

    // The whole point of threading the failure rather than rebuilding it: an
    // orchestration layer must not be where "wait 30 seconds" gets lost.
    assert.equal(outcome.failures[0].retryAfterMs, 30_000);
    assert.equal(outcome.failures[0].code, "LLM_RATE_LIMITED");
  });

  it("carries a uniqueness abort's reason and attempt count through untouched", async () => {
    const { generate } = makeDeps({
      instagram: {
        success: false,
        code: "CANNOT_GENERATE_UNIQUE_POST",
        reason: "semantic_duplicate",
        attempts: 3,
      },
    });

    const outcome = await generateTopicAcrossChannels(makeInput(), { generate });

    assert.equal(outcome.failures[0].reason, "semantic_duplicate");
    assert.equal(outcome.failures[0].attempts, 3);
  });

  it("gives a failure the generator did not phrase a readable message", async () => {
    const { generate } = makeDeps({
      facebook: { success: false, code: "CANNOT_GENERATE_UNIQUE_POST" },
    });

    const outcome = await generateTopicAcrossChannels(makeInput(), { generate });

    assert.equal(typeof outcome.failures[0].message, "string");
    assert.ok(outcome.failures[0].message.length > 0);
  });

  it("keeps the generator's own wording when it had some", async () => {
    const { generate } = makeDeps({
      facebook: {
        success: false,
        code: "SELECTED_SOURCE_UNAVAILABLE",
        message: "That feed is dry.",
      },
    });

    const outcome = await generateTopicAcrossChannels(makeInput(), { generate });

    assert.equal(outcome.failures[0].message, "That feed is dry.");
  });
});

// ─── Progress ─────────────────────────────────────────────────────────────────

describe("generateTopicAcrossChannels — reporting as it goes", () => {
  it("reports after each committed channel, with the anchor as soon as it exists", async () => {
    const { generate } = makeDeps();
    const seen: Array<{ posts: number; anchor: string | null }> = [];

    await generateTopicAcrossChannels(makeInput(), {
      generate,
      onChannelComplete: async (partial: TopicGenerationOutcome) => {
        seen.push({
          posts: partial.posts.length,
          anchor: partial.anchor?.establishedBy ?? null,
        });
      },
    });

    // One report per committed channel — and the anchor is already there on the
    // first, which is what makes a retry resume THIS topic.
    assert.deepEqual(seen, [
      { posts: 1, anchor: "linkedin" },
      { posts: 2, anchor: "linkedin" },
      { posts: 3, anchor: "linkedin" },
    ]);
  });

  it("does not report for a channel that failed", async () => {
    const { generate } = makeDeps({
      facebook: { success: false, code: "LLM_PROVIDER_ERROR" },
    });
    let reports = 0;

    await generateTopicAcrossChannels(makeInput(), {
      generate,
      onChannelComplete: async () => {
        reports += 1;
      },
    });

    assert.equal(reports, 2);
  });
});

// ─── The time budget ──────────────────────────────────────────────────────────

describe("generateTopicAcrossChannels — the time budget", () => {
  it("attempts every channel when there is no deadline installed", async () => {
    const { generate, calls } = makeDeps();

    // The default reader is the ambient one, which is +Infinity outside a
    // deadline. Every path that has all the time it needs — the worker, the
    // tests — must behave exactly as it did before the budget existed.
    const outcome = await generateTopicAcrossChannels(makeInput(), { generate });

    assert.equal(calls().length, 3);
    assert.deepEqual(outcome.notAttempted, []);
  });

  it("stops starting channels once the remaining budget is too small", async () => {
    const { generate, calls } = makeDeps();

    // The first channel is never gated, so the budget is not even read for it.
    // By the time it is, the first generation has spent almost everything.
    const outcome = await generateTopicAcrossChannels(makeInput(), {
      generate,
      remainingBudgetMs: () => 10_000,
      minChannelBudgetMs: 45_000,
    });

    // Only the first channel ran, and it is a real committed post.
    assert.deepEqual(
      calls().map((c) => c.channel),
      ["linkedin"]
    );
    assert.equal(outcome.posts.length, 1);
    // The other two are named — not silently missing, and not reported as
    // generations that went wrong.
    assert.deepEqual(outcome.notAttempted, ["facebook", "instagram"]);
    assert.equal(outcome.failures.length, 0);
  });

  it("always attempts the first channel, however little time is left", async () => {
    const { generate, calls } = makeDeps();

    const outcome = await generateTopicAcrossChannels(makeInput(), {
      generate,
      // Already past the deadline before the first channel starts.
      remainingBudgetMs: () => -5_000,
      minChannelBudgetMs: 45_000,
    });

    // A caller must never be told "no time" without a single try.
    assert.equal(calls().length, 1);
    assert.equal(outcome.posts.length, 1);
    assert.deepEqual(outcome.notAttempted, ["facebook", "instagram"]);
  });

  it("counts a FAILED first channel as having had its turn", async () => {
    const { generate, calls } = makeDeps({
      linkedin: { success: false, code: "LLM_PROVIDER_ERROR" },
    });

    const outcome = await generateTopicAcrossChannels(makeInput(), {
      generate,
      remainingBudgetMs: () => 1_000,
      minChannelBudgetMs: 45_000,
    });

    // The budget gate is about time spent, not posts produced: a channel that
    // burned the budget and failed must not hand its turn to the next one.
    assert.equal(calls().length, 1);
    assert.equal(outcome.failures.length, 1);
    assert.deepEqual(outcome.notAttempted, ["facebook", "instagram"]);
  });

  it("skips already-generated channels without spending anyone's turn", async () => {
    const { generate, calls } = makeDeps();

    const outcome = await generateTopicAcrossChannels(
      makeInput({ alreadyGenerated: ["linkedin"] }),
      {
        generate,
        remainingBudgetMs: () => 1_000,
        minChannelBudgetMs: 45_000,
      }
    );

    // A resumed run must still get one real attempt: `linkedin` was skipped
    // because it exists, not because it was tried, so `facebook` is the first
    // channel of THIS call and is never gated.
    assert.deepEqual(
      calls().map((c) => c.channel),
      ["facebook"]
    );
    assert.deepEqual(outcome.notAttempted, ["instagram"]);
  });

  it("keeps every post written before the budget ran out", async () => {
    const { generate } = makeDeps();
    // Readings, in order, for channels 2 and 3 — channel 1 is never gated.
    const budgets = [600_000, 1_000];
    let i = 0;

    const outcome = await generateTopicAcrossChannels(makeInput(), {
      generate,
      remainingBudgetMs: () => budgets[Math.min(i++, budgets.length - 1)],
      minChannelBudgetMs: 45_000,
    });

    // The whole reason the budget exists: running out of time degrades into a
    // partial group rather than losing the posts already committed.
    assert.equal(outcome.posts.length, 2);
    assert.deepEqual(outcome.notAttempted, ["instagram"]);
    assert.notEqual(outcome.anchor, null);
  });
});

// ─── The gate calibrates itself from what a channel actually costs ────────────

/**
 * A run on a fake clock, where each channel costs what the test says it costs.
 *
 * The budget and the costs are quoted in the same currency and read from the
 * same clock, which is the only way the calibration can be tested honestly: the
 * question it answers — "would another channel like the last one still fit?" —
 * is meaningless if the two are scripted independently.
 */
function timedRun(options: {
  budgetMs: number;
  costs: Record<string, number>;
  script?: Record<string, GenerateDraftPostResult>;
  input?: Partial<GenerateTopicInput>;
}): Promise<TopicGenerationOutcome> {
  let elapsed = 0;
  const { generate } = makeDeps(options.script ?? {});

  return generateTopicAcrossChannels(makeInput(options.input), {
    generate: async (slug, channel, userId, isGlobalAdmin, opts) => {
      const result = await generate!(slug, channel, userId, isGlobalAdmin, opts);
      // The generation itself is what consumes the clock, exactly as in
      // production, where the LLM call runs before any image work.
      elapsed += options.costs[channel] ?? 0;
      return result;
    },
    now: () => elapsed,
    remainingBudgetMs: () => options.budgetMs - elapsed,
  });
}

describe("generateTopicAcrossChannels — sizing the gate from real cost", () => {
  it("does not start a channel that costs more than the time left", async () => {
    // The observed failure, to scale. The first channel took 158s (an 80s LLM
    // call and a 76s image); 82s remained after it. The old gate compared that
    // against a flat 45s, admitted the second channel, and the LLM alone then
    // consumed the rest — so every image call was made with a budget of zero,
    // aborted instantly, and the post was committed with an image prompt and no
    // image, on a channel whose imageRequired is true.
    const outcome = await timedRun({
      budgetMs: 240_000,
      costs: { linkedin: 158_000, facebook: 158_000, instagram: 158_000 },
    });

    assert.equal(outcome.posts.length, 1);
    // Reported, retryable, and — the point — not a draft that can never be
    // published.
    assert.deepEqual(outcome.notAttempted, ["facebook", "instagram"]);
    assert.equal(outcome.failures.length, 0);
  });

  it("keeps going when channels are genuinely cheap", async () => {
    // The same budget and the same floor: what changed is only what a channel
    // costs here. A gate calibrated from measurement must not punish a fast
    // environment for the sake of a slow one.
    const outcome = await timedRun({
      budgetMs: 240_000,
      costs: { linkedin: 5_000, facebook: 5_000, instagram: 5_000 },
    });

    assert.equal(outcome.posts.length, 3);
    assert.deepEqual(outcome.notAttempted, []);
  });

  it("still applies the floor when no channel has taken measurable time", async () => {
    // Nothing measured yet is not evidence that a channel is free. With less
    // than MIN_CHANNEL_BUDGET_MS left, the floor is what refuses the next one.
    const outcome = await timedRun({
      budgetMs: 40_000,
      costs: { linkedin: 0, facebook: 0, instagram: 0 },
    });

    assert.equal(outcome.posts.length, 1);
    assert.deepEqual(outcome.notAttempted, ["facebook", "instagram"]);
  });

  it("learns the cost from a channel that FAILED, not only from one that worked", async () => {
    // Two minutes of LLM retries ending in a provider error says just as much
    // about what a channel costs as two minutes ending in a post.
    const outcome = await timedRun({
      budgetMs: 240_000,
      costs: { linkedin: 150_000, facebook: 150_000, instagram: 150_000 },
      script: { linkedin: { success: false, code: "LLM_PROVIDER_ERROR" } },
    });

    assert.equal(outcome.failures.length, 1);
    assert.equal(outcome.posts.length, 0);
    assert.deepEqual(outcome.notAttempted, ["facebook", "instagram"]);
  });

  it("holds the bar at the SLOWEST channel seen, not the most recent", async () => {
    // linkedin costs 150s, facebook 10s, leaving 145s. That is ample for another
    // facebook and short of another linkedin — so a gate reading only the most
    // recent channel would admit instagram, and one holding the maximum refuses
    // it. One cheap channel is not evidence that the next one is cheap.
    const outcome = await timedRun({
      budgetMs: 305_000,
      costs: { linkedin: 150_000, facebook: 10_000, instagram: 150_000 },
    });

    assert.equal(outcome.posts.length, 2);
    assert.deepEqual(outcome.notAttempted, ["instagram"]);
  });
});
