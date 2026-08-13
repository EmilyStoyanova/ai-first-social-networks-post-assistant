import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  topicGenerationPayloadSchema,
  parseTopicGenerationProgress,
} from "./topic-generation-payload";

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: "acme",
    userId: "user-1",
    contentGroupId: "group-1",
    channels: ["linkedin", "facebook"],
    ...overrides,
  };
}

describe("topicGenerationPayloadSchema", () => {
  it("accepts a minimal two-channel request", () => {
    const parsed = topicGenerationPayloadSchema.safeParse(payload());
    assert.equal(parsed.success, true);
  });

  it("normalises channel casing, as the route's own schema does", () => {
    const parsed = topicGenerationPayloadSchema.safeParse(
      payload({ channels: ["LinkedIn", "FACEBOOK"] })
    );
    assert.equal(parsed.success, true);
    if (!parsed.success) return;
    assert.deepEqual(parsed.data.channels, ["linkedin", "facebook"]);
  });

  it("refuses a single channel — that path is answered inline", () => {
    assert.equal(
      topicGenerationPayloadSchema.safeParse(payload({ channels: ["linkedin"] })).success,
      false
    );
  });

  it("refuses a repeated channel", () => {
    // One topic written twice for a channel is refused by the (article, channel)
    // unique index anyway; better here than as a crash halfway through a worker.
    assert.equal(
      topicGenerationPayloadSchema.safeParse(payload({ channels: ["linkedin", "linkedin"] }))
        .success,
      false
    );
  });

  it("refuses an unknown channel", () => {
    assert.equal(
      topicGenerationPayloadSchema.safeParse(payload({ channels: ["linkedin", "myspace"] }))
        .success,
      false
    );
  });

  it("refuses a payload with no content group", () => {
    const { contentGroupId: _dropped, ...rest } = payload();
    assert.equal(topicGenerationPayloadSchema.safeParse(rest).success, false);
  });

  it("refuses an unknown field rather than silently dropping it", () => {
    // `.strict()`: a payload written by a newer deploy and read by an older
    // worker must fail loudly, not run against instructions nobody gave.
    assert.equal(
      topicGenerationPayloadSchema.safeParse(payload({ scheduledFor: "2026-08-20" })).success,
      false
    );
  });

  it("has no place for admin rights", () => {
    assert.equal(
      topicGenerationPayloadSchema.safeParse(payload({ isGlobalAdmin: true })).success,
      false
    );
  });
});

describe("parseTopicGenerationProgress", () => {
  it("is null before anything has been recorded", () => {
    assert.equal(parseTopicGenerationProgress(null), null);
  });

  it("reads a mid-flight snapshot", () => {
    const parsed = parseTopicGenerationProgress({
      contentGroupId: "group-1",
      channels: ["linkedin", "facebook"],
      posts: [{ channel: "linkedin", postId: "p1", post: { id: "p1", content: "Hello" } }],
      failures: [],
      notAttempted: [],
      anchor: {
        primaryFeedItemId: "feed-1",
        coreMessage: "One claim.",
        topic: "t",
        establishedBy: "linkedin",
      },
    });

    assert.ok(parsed);
    assert.equal(parsed.posts.length, 1);
    assert.equal(parsed.anchor?.establishedBy, "linkedin");
  });

  it("defaults the lists so a reader never branches on undefined", () => {
    const parsed = parseTopicGenerationProgress({ contentGroupId: "group-1" });

    assert.ok(parsed);
    assert.deepEqual(parsed.posts, []);
    assert.deepEqual(parsed.failures, []);
    assert.deepEqual(parsed.notAttempted, []);
  });

  it("keeps a field it does not know about rather than failing on it", () => {
    // Progress is a report, not an instruction: an older reader should degrade
    // to less detail, never to a crash that strands committed posts.
    const parsed = parseTopicGenerationProgress({
      contentGroupId: "group-1",
      somethingNewer: 42,
    });

    assert.ok(parsed);
    assert.equal((parsed as Record<string, unknown>).somethingNewer, 42);
  });

  it("is null rather than a throw for a record that makes no sense", () => {
    assert.equal(parseTopicGenerationProgress({ posts: "not an array" }), null);
  });
});
