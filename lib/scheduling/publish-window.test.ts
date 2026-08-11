import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PAST_DUE_GRACE_MS,
  PUBLISH_LOOKAHEAD_MS,
  PUBLISH_SWEEP_INTERVAL_MS,
  blocksOnDemandPublish,
  decidePublish,
  partitionByPublishDecision,
  pastDueMessage,
  type PublishCandidate,
} from "./publish-window";

const NOW = new Date("2026-08-20T07:00:00.000Z");

function manual(scheduledFor: string | null): PublishCandidate {
  return {
    scheduledFor: scheduledFor === null ? null : new Date(scheduledFor),
    generationBatchId: "batch-1",
  };
}

function automatic(scheduledFor: string | null): PublishCandidate {
  return {
    scheduledFor: scheduledFor === null ? null : new Date(scheduledFor),
    generationBatchId: null,
  };
}

describe("decidePublish — a manually scheduled post waits for its time", () => {
  it("does not publish before the time the user chose", () => {
    // The whole point of the bulk scheduling UI: a post placed on Friday at
    // 18:30 must not go out on Wednesday morning.
    assert.equal(decidePublish(manual("2026-08-22T18:30:00.000Z"), NOW), "not_due");
  });

  it("does not publish one minute early either", () => {
    assert.equal(decidePublish(manual("2026-08-20T07:01:00.000Z"), NOW), "not_due");
  });

  it("publishes once the time has arrived", () => {
    assert.equal(decidePublish(manual("2026-08-20T07:00:00.000Z"), NOW), "publish");
    assert.equal(decidePublish(manual("2026-08-20T06:59:00.000Z"), NOW), "publish");
  });

  it("still publishes a post the sweep could only reach on its next tick", () => {
    // Due at 06:45, first seen at 07:00 — a quarter of an hour late through
    // nobody's fault. A grace shorter than one sweep interval would refuse every
    // manual post not scheduled exactly on a tick.
    assert.equal(decidePublish(manual("2026-08-20T06:45:00.000Z"), NOW), "publish");
  });

  it("survives a couple of missed ticks — a deploy, a cold start", () => {
    const twoTicksAgo = new Date(NOW.getTime() - 2 * PUBLISH_SWEEP_INTERVAL_MS);
    assert.equal(decidePublish(manual(twoTicksAgo.toISOString()), NOW), "publish");
  });

  it("publishes at the exact edge of the grace window", () => {
    const edge = new Date(NOW.getTime() - PAST_DUE_GRACE_MS);
    assert.equal(decidePublish(manual(edge.toISOString()), NOW), "publish");
  });

  it("refuses to fire once the grace window is past", () => {
    const past = new Date(NOW.getTime() - PAST_DUE_GRACE_MS - 1);
    assert.equal(decidePublish(manual(past.toISOString()), NOW), "past_due");
  });

  it("refuses a post whose slot was hours ago, not just days", () => {
    // The grace is sized for a missed tick, not for a missed morning: 90 minutes
    // late is still the same part of the same day, three hours late is not.
    assert.equal(decidePublish(manual("2026-08-20T03:00:00.000Z"), NOW), "past_due");
  });

  it("refuses a post approved days after its slot", () => {
    // The edge case that matters: approval happening long after scheduledFor
    // must not turn into an immediate, unannounced publish.
    assert.equal(decidePublish(manual("2026-08-10T09:00:00.000Z"), NOW), "past_due");
  });

  it("is never due without a time of its own", () => {
    assert.equal(decidePublish(manual(null), NOW), "not_due");
  });
});

describe("the grace is derived from the sweep interval", () => {
  it("is a whole number of sweep intervals, and more than one", () => {
    // A grace below one interval refuses every manual post; a grace that is not
    // a multiple of it is a number somebody guessed.
    assert.equal(PAST_DUE_GRACE_MS % PUBLISH_SWEEP_INTERVAL_MS, 0);
    assert.ok(PAST_DUE_GRACE_MS > PUBLISH_SWEEP_INTERVAL_MS);
  });

  it("is 90 minutes, for a sweep every 30", () => {
    assert.equal(PUBLISH_SWEEP_INTERVAL_MS, 30 * 60 * 1000);
    assert.equal(PAST_DUE_GRACE_MS, 90 * 60 * 1000);
  });

  it("stays far below the look-ahead automatic posts get", () => {
    // The two are different promises: an estimate the publisher may act on
    // early, versus a time a person named. They must not converge.
    assert.ok(PAST_DUE_GRACE_MS < PUBLISH_LOOKAHEAD_MS);
  });
});

describe("decidePublish — an automatic post keeps the behaviour it always had", () => {
  it("publishes inside the 48-hour look-ahead", () => {
    assert.equal(decidePublish(automatic("2026-08-21T09:00:00.000Z"), NOW), "publish");
  });

  it("publishes at the very edge of the look-ahead", () => {
    const edge = new Date(NOW.getTime() + PUBLISH_LOOKAHEAD_MS);
    assert.equal(decidePublish(automatic(edge.toISOString()), NOW), "publish");
  });

  it("waits for anything beyond the look-ahead", () => {
    const beyond = new Date(NOW.getTime() + PUBLISH_LOOKAHEAD_MS + 1);
    assert.equal(decidePublish(automatic(beyond.toISOString()), NOW), "not_due");
  });

  it("still publishes a late one rather than parking it", () => {
    // Deliberate: the past-due policy is scoped to schedules a human authored.
    // Changing this would change the automated pipeline's timing, which is out
    // of scope for manual bulk generation.
    assert.equal(decidePublish(automatic("2026-07-01T09:00:00.000Z"), NOW), "publish");
  });

  it("is never due without a time of its own", () => {
    assert.equal(decidePublish(automatic(null), NOW), "not_due");
  });
});

describe("partitionByPublishDecision", () => {
  it("sends the due ones, parks the stale ones and ignores the rest", () => {
    const posts = [
      { id: "due-manual", ...manual("2026-08-20T06:00:00.000Z") },
      { id: "future-manual", ...manual("2026-08-25T09:00:00.000Z") },
      { id: "stale-manual", ...manual("2026-08-01T09:00:00.000Z") },
      { id: "due-auto", ...automatic("2026-08-21T09:00:00.000Z") },
    ];

    const { due, pastDue } = partitionByPublishDecision(posts, NOW);

    assert.deepEqual(
      due.map((p) => p.id),
      ["due-manual", "due-auto"]
    );
    assert.deepEqual(
      pastDue.map((p) => p.id),
      ["stale-manual"]
    );
  });

  it("preserves the order it was given", () => {
    // The publisher sorts by scheduledFor, so the oldest post keeps going first.
    // Both inside the grace window; ordering is not the thing being tested here.
    const posts = [
      { id: "b", ...manual("2026-08-20T06:50:00.000Z") },
      { id: "a", ...manual("2026-08-20T06:20:00.000Z") },
    ];

    assert.deepEqual(
      partitionByPublishDecision(posts, NOW).due.map((p) => p.id),
      ["b", "a"]
    );
  });

  it("returns nothing for an empty batch", () => {
    assert.deepEqual(partitionByPublishDecision([], NOW), { due: [], pastDue: [] });
  });
});

describe("pastDueMessage", () => {
  it("names the time that was missed", () => {
    const message = pastDueMessage(new Date("2026-08-01T09:00:00.000Z"));
    assert.match(message, /2026-08-01T09:00:00\.000Z/);
  });

  it("is stable for the same time, so a repeating sweep does not re-park forever", () => {
    const when = new Date("2026-08-01T09:00:00.000Z");
    assert.equal(pastDueMessage(when), pastDueMessage(new Date(when)));
  });

  it("differs once the post is given a different time", () => {
    assert.notEqual(
      pastDueMessage(new Date("2026-08-01T09:00:00.000Z")),
      pastDueMessage(new Date("2026-08-02T09:00:00.000Z"))
    );
  });
});

// ─── On-demand publishing (the card's button, not the sweep) ──────────────────

describe("blocksOnDemandPublish", () => {
  const NOON = new Date("2026-08-12T09:00:00.000Z");

  it("blocks a manual post whose time is still ahead", () => {
    assert.equal(
      blocksOnDemandPublish(
        { scheduledFor: NOON, generationBatchId: "batch-1" },
        new Date("2026-08-12T08:48:00.000Z")
      ),
      true
    );
  });

  it("blocks it one millisecond early", () => {
    assert.equal(
      blocksOnDemandPublish(
        { scheduledFor: NOON, generationBatchId: "batch-1" },
        new Date(NOON.getTime() - 1)
      ),
      true
    );
  });

  it("allows it exactly on time", () => {
    assert.equal(
      blocksOnDemandPublish({ scheduledFor: NOON, generationBatchId: "batch-1" }, NOON),
      false
    );
  });

  it("allows a manual post that is past due — publishing by hand is its way out", () => {
    // decidePublish says "past_due" here and the sweep parks it; a person must
    // still be able to send it, so this predicate must NOT follow that decision.
    const late = new Date("2026-08-14T09:00:00.000Z");
    assert.equal(
      decidePublish({ scheduledFor: NOON, generationBatchId: "batch-1" }, late),
      "past_due"
    );
    assert.equal(
      blocksOnDemandPublish({ scheduledFor: NOON, generationBatchId: "batch-1" }, late),
      false
    );
  });

  it("allows an unscheduled post, which is the ordinary publish-now case", () => {
    // decidePublish calls this "not_due" forever; on demand it is the norm.
    assert.equal(decidePublish({ scheduledFor: null, generationBatchId: null }, NOON), "not_due");
    assert.equal(
      blocksOnDemandPublish({ scheduledFor: null, generationBatchId: null }, NOON),
      false
    );
  });

  it("allows an unscheduled post that came from a bulk run", () => {
    assert.equal(
      blocksOnDemandPublish({ scheduledFor: null, generationBatchId: "batch-1" }, NOON),
      false
    );
  });

  it("never blocks an automatic post, however far out its estimate is", () => {
    for (const now of [
      new Date("2026-08-12T08:48:00.000Z"),
      new Date("2026-08-01T09:00:00.000Z"),
      new Date("2026-01-01T09:00:00.000Z"),
    ]) {
      assert.equal(
        blocksOnDemandPublish({ scheduledFor: NOON, generationBatchId: null }, now),
        false
      );
    }
  });
});
