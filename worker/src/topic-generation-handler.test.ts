import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createTopicGenerationHandler,
  mergeTopicProgress,
  toTopicResumeState,
  TOPIC_GENERATION_JOB_TYPE,
} from "./topic-generation-handler";
import type { JobRecord } from "./job-store";
import type { Logger } from "./logger";
import type {
  GenerateTopicInput,
  TopicGenerationOutcome,
} from "@/lib/services/ai/generate-topic-across-channels.service";
import type { TopicGenerationProgress } from "@/lib/queue/topic-generation-payload";

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

const SLUG = "acme";
const USER_ID = "user-1";
const GROUP_ID = "group-1";

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: SLUG,
    userId: USER_ID,
    contentGroupId: GROUP_ID,
    channels: ["linkedin", "facebook", "instagram"],
    ...overrides,
  };
}

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    type: TOPIC_GENERATION_JOB_TYPE,
    payload: payload(),
    attempts: 1,
    maxAttempts: 2,
    result: null,
    ...overrides,
  };
}

/** A generated post, only as far as the handler and the UI care about it. */
function post(id: string, channel: string) {
  return {
    id,
    channel,
    content: `Post ${id}`,
    companyId: "company-1",
    contentGroupId: GROUP_ID,
    primaryFeedItemId: "feed-1",
    coreMessage: "One claim.",
    topic: "topic-1",
    scheduledFor: null,
  } as unknown as TopicGenerationOutcome["posts"][number]["post"];
}

const NO_WARNINGS = {
  duplicate: { flagged: false, similarityScore: null, matchedPostId: null },
  safety: { flagged: false, matchedTerms: [] },
  semanticDuplicate: {
    decision: "accept",
    topSimilarity: null,
    matchedPostId: null,
    exhausted: false,
    skipped: false,
  },
} as unknown as TopicGenerationOutcome["posts"][number]["warnings"];

function outcome(overrides: Partial<TopicGenerationOutcome> = {}): TopicGenerationOutcome {
  return {
    contentGroupId: GROUP_ID,
    companyId: "company-1",
    posts: [],
    failures: [],
    notAttempted: [],
    anchor: null,
    ...overrides,
  };
}

function channelPost(channel: string, postId: string) {
  return {
    channel,
    postId,
    scheduledFor: null,
    post: post(postId, channel),
    warnings: NO_WARNINGS,
  };
}

const ANCHOR = {
  primaryFeedItemId: "feed-1",
  coreMessage: "One claim.",
  topic: "topic-1",
  establishedBy: "linkedin",
};

/**
 * The handler under test, with the orchestrator replaced by a script.
 *
 * Nothing about generation is simulated — the anchor-and-pin, the reservation
 * and the duplicate gates all have their own tests. What is under test here is
 * the adapter: what it reads out of the payload, what it resumes from, what it
 * records, and what it decides is worth a retry.
 */
function makeHandler(
  options: {
    result?: TopicGenerationOutcome;
    /** Channels to "commit" one at a time through `onChannelComplete`. */
    stream?: string[];
    resolveRequester?: (userId: string) => Promise<{ isGlobalAdmin: boolean } | null>;
  } = {}
) {
  const calls: GenerateTopicInput[] = [];
  const progressWrites: TopicGenerationProgress[] = [];

  const handler = createTopicGenerationHandler({
    resolveRequester: options.resolveRequester ?? (async () => ({ isGlobalAdmin: false })),
    generateTopic: async (input, deps) => {
      calls.push(input);
      const committed: TopicGenerationOutcome["posts"] = [];
      for (const channel of options.stream ?? []) {
        committed.push(channelPost(channel, `post-${channel}`));
        await deps?.onChannelComplete?.(outcome({ posts: [...committed], anchor: ANCHOR }));
      }
      return (
        options.result ?? outcome({ posts: committed, anchor: committed.length ? ANCHOR : null })
      );
    },
  });

  return {
    run: async (j: JobRecord = job()) =>
      (await handler({
        job: j,
        logger: silentLogger,
        reportProgress: async (p) => {
          progressWrites.push(p as unknown as TopicGenerationProgress);
        },
      })) as unknown as TopicGenerationProgress,
    calls: () => calls,
    progressWrites: () => progressWrites,
  };
}

describe("topic generation handler — running the orchestrator", () => {
  it("passes the payload's own content group, so a retry cannot split the topic", async () => {
    const h = makeHandler({ stream: ["linkedin"] });
    await h.run();

    assert.equal(h.calls()[0].contentGroupId, GROUP_ID);
  });

  it("resolves admin rights at execution time rather than trusting the payload", async () => {
    // The payload deliberately carries no `isGlobalAdmin`; a job can sit in the
    // queue across the moment someone's rights change.
    const h = makeHandler({
      stream: ["linkedin"],
      resolveRequester: async () => ({ isGlobalAdmin: true }),
    });
    await h.run();

    assert.equal(h.calls()[0].isGlobalAdmin, true);
  });

  it("asks for every selected channel on a first attempt", async () => {
    const h = makeHandler({ stream: ["linkedin"] });
    await h.run();

    assert.deepEqual([...h.calls()[0].channels], ["linkedin", "facebook", "instagram"]);
    assert.equal(h.calls()[0].anchor, null);
  });

  it("records a channel the moment it commits, with the post itself", async () => {
    // The whole reason this progress carries posts rather than ids: the form
    // adds a card per poll instead of waiting for the run to end.
    const h = makeHandler({ stream: ["linkedin", "facebook"] });
    await h.run();

    const writes = h.progressWrites();
    assert.equal(writes.length, 2);
    assert.equal(writes[0].posts.length, 1);
    assert.equal(writes[0].posts[0].channel, "linkedin");
    assert.ok(writes[0].posts[0].post, "the finished post travels with the id");
    assert.equal(writes[1].posts.length, 2);
  });

  it("records the channels ASKED FOR, so the UI denominator is stable", async () => {
    const h = makeHandler({ stream: ["linkedin"] });
    const result = await h.run();

    assert.deepEqual(result.channels, ["linkedin", "facebook", "instagram"]);
  });
});

describe("topic generation handler — failures are data, not retries", () => {
  it("completes with the failure recorded when a channel produces nothing", async () => {
    const h = makeHandler({
      result: outcome({
        posts: [channelPost("linkedin", "post-1")],
        failures: [
          {
            success: false as const,
            channel: "facebook",
            code: "CANNOT_GENERATE_UNIQUE_POST",
            message: "Too similar.",
            reason: "semantic_duplicate",
            attempts: 3,
          },
        ],
        anchor: ANCHOR,
      }),
    });

    const result = await h.run();

    assert.equal(result.posts.length, 1);
    assert.equal(result.failures.length, 1);
    // The diagnostics the UI translates and explains with must survive.
    assert.equal(result.failures[0].code, "CANNOT_GENERATE_UNIQUE_POST");
    assert.equal(result.failures[0].reason, "semantic_duplicate");
    assert.equal(result.failures[0].attempts, 3);
  });

  it("completes even when EVERY channel failed", async () => {
    // Thrown would buy a retry of generations that already know they cannot
    // succeed, and would replace structured codes with one English string.
    const h = makeHandler({
      result: outcome({
        companyId: null,
        failures: [
          {
            success: false as const,
            channel: "linkedin",
            code: "NO_FEED_ITEMS_AVAILABLE",
            message: "Nothing left.",
          },
          {
            success: false as const,
            channel: "facebook",
            code: "NO_FEED_ITEMS_AVAILABLE",
            message: "Nothing left.",
          },
        ],
      }),
    });

    const result = await h.run();

    assert.equal(result.posts.length, 0);
    assert.equal(result.failures.length, 2);
  });

  it("throws on a malformed payload, which is what a retry policy is for", async () => {
    const h = makeHandler({});
    await assert.rejects(
      () => h.run(job({ payload: { slug: SLUG } })),
      /Invalid topic-generation payload/
    );
  });

  it("throws when the requester no longer exists", async () => {
    const h = makeHandler({ resolveRequester: async () => null });
    await assert.rejects(() => h.run(), /no longer exists/);
  });

  it("refuses a single-channel payload — that path is answered inline", async () => {
    const h = makeHandler({});
    await assert.rejects(
      () => h.run(job({ payload: payload({ channels: ["linkedin"] }) })),
      /Invalid topic-generation payload/
    );
  });
});

describe("topic generation handler — resuming a half-written topic", () => {
  const priorProgress = {
    contentGroupId: GROUP_ID,
    channels: ["linkedin", "facebook", "instagram"],
    posts: [{ channel: "linkedin", postId: "post-linkedin", post: { id: "post-linkedin" } }],
    failures: [],
    notAttempted: [],
    anchor: ANCHOR,
  };

  it("asks only for the channels still missing", async () => {
    const h = makeHandler({ stream: ["facebook"] });
    await h.run(job({ result: priorProgress, attempts: 2 }));

    assert.deepEqual([...h.calls()[0].channels], ["facebook", "instagram"]);
  });

  it("continues the SAME topic instead of letting siblings pick their own", async () => {
    // Without the anchor a resumed run would fragment one group into unrelated
    // posts that happen to share an id.
    const h = makeHandler({ stream: ["facebook"] });
    await h.run(job({ result: priorProgress, attempts: 2 }));

    assert.deepEqual(h.calls()[0].anchor, ANCHOR);
    assert.deepEqual([...(h.calls()[0].alreadyGenerated ?? [])], ["linkedin"]);
  });

  it("keeps the earlier attempt's channels in the report", async () => {
    const h = makeHandler({ stream: ["facebook"] });
    const result = await h.run(job({ result: priorProgress, attempts: 2 }));

    assert.deepEqual(
      result.posts.map((p) => p.channel),
      ["linkedin", "facebook"]
    );
  });

  it("does not regenerate when every channel was already committed", async () => {
    // A retry after the last progress write but before completion was recorded.
    const h = makeHandler({ stream: ["should-not-run"] });
    const complete = {
      ...priorProgress,
      posts: ["linkedin", "facebook", "instagram"].map((c) => ({
        channel: c,
        postId: `post-${c}`,
        post: { id: `post-${c}` },
      })),
    };

    const result = await h.run(job({ result: complete, attempts: 2 }));

    assert.equal(h.calls().length, 0, "nothing is generated a second time");
    assert.equal(result.posts.length, 3);
  });
});

describe("toTopicResumeState", () => {
  it("is null on a first attempt", () => {
    assert.equal(toTopicResumeState(null), null);
  });

  it("is null when progress exists but nothing was committed", () => {
    // Nothing to skip and no anchor to continue — a fresh run, not a resume.
    assert.equal(
      toTopicResumeState({ contentGroupId: GROUP_ID, posts: [], failures: [], notAttempted: [] }),
      null
    );
  });

  it("is null rather than a throw when the record cannot be parsed", () => {
    // A job that refuses to start because it cannot read its own diary is
    // strictly worse than one that starts over.
    assert.equal(toTopicResumeState({ nonsense: true }), null);
  });
});

describe("mergeTopicProgress", () => {
  const input = { contentGroupId: GROUP_ID, channels: ["linkedin", "facebook"] as const };

  it("does not duplicate a channel reported by both attempts", () => {
    const merged = mergeTopicProgress(input, outcome({ posts: [channelPost("linkedin", "x")] }), {
      alreadyGenerated: ["linkedin"],
      anchor: ANCHOR,
      posts: [{ channel: "linkedin", postId: "post-linkedin" }],
    });

    assert.equal(merged.posts.length, 1);
    // The committed one is the earlier: it is the row that actually exists.
    assert.equal(merged.posts[0].postId, "post-linkedin");
  });

  it("puts earlier channels first, preserving the order they were written in", () => {
    const merged = mergeTopicProgress(input, outcome({ posts: [channelPost("facebook", "p2")] }), {
      alreadyGenerated: ["linkedin"],
      anchor: ANCHOR,
      posts: [{ channel: "linkedin", postId: "p1" }],
    });

    assert.deepEqual(
      merged.posts.map((p) => p.postId),
      ["p1", "p2"]
    );
  });

  it("serialises a schedule to ISO so it survives the queue's JSON column", () => {
    const scheduled = new Date("2026-08-20T09:00:00.000Z");
    const merged = mergeTopicProgress(
      input,
      outcome({ posts: [{ ...channelPost("linkedin", "p1"), scheduledFor: scheduled }] }),
      null
    );

    assert.equal(merged.posts[0].scheduledFor, "2026-08-20T09:00:00.000Z");
  });
});
