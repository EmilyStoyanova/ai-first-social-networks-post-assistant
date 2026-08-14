import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  channelGaps,
  hasNoPosts,
  newTopicPosts,
  summarizeTopicJob,
  type TopicJobProgress,
} from "./topic-job";
import { resolveBulkJobPhase, bulkPollIntervalMs } from "./bulk-job";

function progress(overrides: Partial<TopicJobProgress> = {}): TopicJobProgress {
  return {
    contentGroupId: "group-1",
    channels: ["linkedin", "facebook", "instagram"],
    posts: [],
    failures: [],
    notAttempted: [],
    ...overrides,
  };
}

describe("summarizeTopicJob", () => {
  it("is all zeros with the form's denominator before any progress exists", () => {
    // So the panel renders "0 of 3" on the click, rather than branching on null.
    assert.deepEqual(summarizeTopicJob(null, ["linkedin", "facebook", "instagram"]), {
      written: 0,
      total: 3,
      failed: 0,
    });
  });

  it("counts committed channels against the channels asked for", () => {
    const counts = summarizeTopicJob(progress({ posts: [{ channel: "linkedin", postId: "p1" }] }), [
      "linkedin",
    ]);

    assert.equal(counts.written, 1);
    // The RUN's list wins over this tab's: a resumed attempt still reports every
    // channel the topic was asked for, while the form's copy is only what it sent.
    assert.equal(counts.total, 3);
  });

  it("counts failed channels separately from written ones", () => {
    const counts = summarizeTopicJob(
      progress({
        posts: [{ channel: "linkedin", postId: "p1" }],
        failures: [{ channel: "facebook", code: "CANNOT_GENERATE_UNIQUE_POST" }],
      }),
      []
    );

    assert.equal(counts.written, 1);
    assert.equal(counts.failed, 1);
  });

  it("falls back to the form's count when the run recorded no channel list", () => {
    const counts = summarizeTopicJob(progress({ channels: undefined }), ["linkedin", "facebook"]);
    assert.equal(counts.total, 2);
  });
});

describe("newTopicPosts", () => {
  it("returns only what the caller has not seen", () => {
    const p = progress({
      posts: [
        { channel: "linkedin", postId: "p1", post: { id: "p1" } },
        { channel: "facebook", postId: "p2", post: { id: "p2" } },
      ],
    });

    const fresh = newTopicPosts(p, new Set(["p1"]));

    assert.deepEqual(
      fresh.map((f) => f.postId),
      ["p2"]
    );
  });

  it("adds nothing twice when a poll repeats itself", () => {
    // The exact case a retry re-reporting attempt 1's channels would cause.
    const p = progress({ posts: [{ channel: "linkedin", postId: "p1", post: { id: "p1" } }] });

    assert.equal(newTopicPosts(p, new Set(["p1"])).length, 0);
  });

  it("preserves the order channels were written in", () => {
    const p = progress({
      posts: [
        { channel: "linkedin", postId: "p1", post: { id: "p1" } },
        { channel: "facebook", postId: "p2", post: { id: "p2" } },
      ],
    });

    assert.deepEqual(
      newTopicPosts(p, new Set()).map((f) => f.postId),
      ["p1", "p2"]
    );
  });

  it("skips an entry with no post rather than rendering a placeholder", () => {
    // An older worker that recorded only ids has nothing for the grid to show.
    const p = progress({ posts: [{ channel: "linkedin", postId: "p1" }] });

    assert.deepEqual(newTopicPosts(p, new Set()), []);
  });

  it("is empty with no progress at all", () => {
    assert.deepEqual(newTopicPosts(null, new Set()), []);
  });
});

describe("channelGaps", () => {
  it("names failures and never-attempted channels together", () => {
    // They mean the same thing to the person looking at the card: this topic has
    // no version for that channel.
    const p = progress({
      failures: [{ channel: "facebook", code: "NO_FEED_ITEMS_AVAILABLE" }],
      notAttempted: ["instagram"],
    });

    assert.deepEqual(
      channelGaps(p).map((g) => g.channel),
      ["facebook", "instagram"]
    );
  });

  it("carries the failure's own diagnostics through, not just the channel name", () => {
    // The code is the only place the reason exists — a caller that flattens this
    // to a name leaves the user with a channel that produced nothing and no way
    // to find out why.
    const gaps = channelGaps(
      progress({
        failures: [
          {
            channel: "facebook",
            code: "CANNOT_GENERATE_UNIQUE_POST",
            reason: "semantic_duplicate",
            attempts: 3,
          },
        ],
      })
    );

    assert.equal(gaps[0].failure?.code, "CANNOT_GENERATE_UNIQUE_POST");
    assert.equal(gaps[0].failure?.reason, "semantic_duplicate");
    assert.equal(gaps[0].failure?.attempts, 3);
  });

  it("distinguishes a channel that never got a turn from one that failed", () => {
    const gaps = channelGaps(progress({ notAttempted: ["instagram"] }));

    assert.equal(gaps[0].failure, null);
  });

  it("is empty for a complete topic", () => {
    assert.deepEqual(channelGaps(progress()), []);
  });
});

describe("hasNoPosts", () => {
  it("is true when every channel was refused", () => {
    assert.equal(
      hasNoPosts(
        progress({ failures: [{ channel: "linkedin", code: "NO_FEED_ITEMS_AVAILABLE" }] })
      ),
      true
    );
  });

  it("is false as soon as one channel committed", () => {
    assert.equal(hasNoPosts(progress({ posts: [{ channel: "linkedin", postId: "p1" }] })), false);
  });
});

describe("a topic job reuses the bulk lifecycle helpers", () => {
  // Both status endpoints report the same lifecycle and differ only in the
  // progress they carry, so "how long has this been queued" is answered once.
  const status = {
    state: "queued" as const,
    createdAt: new Date("2026-08-12T10:00:00.000Z").toISOString(),
  };

  it("reads as queued before the threshold", () => {
    assert.equal(resolveBulkJobPhase(status, Date.parse(status.createdAt) + 5_000), "queued");
  });

  it("reads as waiting-for-worker once the wait is worth saying out loud", () => {
    assert.equal(
      resolveBulkJobPhase(status, Date.parse(status.createdAt) + 61_000),
      "waiting-for-worker"
    );
  });

  it("stops polling once terminal", () => {
    assert.equal(bulkPollIntervalMs("completed"), 0);
  });
});
