import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PAST_DUE_GRACE_MS,
  PUBLISH_LOOKAHEAD_MS,
  PUBLISH_SWEEP_INTERVAL_MS,
  blocksOnDemandPublish,
  decidePublish,
  isManuallyScheduled,
  missedItsSchedule,
  partitionByPublishDecision,
  pastDueMessage,
  type PublishCandidate,
} from "./publish-window";

const NOW = new Date("2026-08-20T07:00:00.000Z");

function manual(scheduledFor: string | null): PublishCandidate {
  return {
    scheduledFor: scheduledFor === null ? null : new Date(scheduledFor),
    manuallyScheduled: true,
  };
}

function automatic(scheduledFor: string | null): PublishCandidate {
  return {
    scheduledFor: scheduledFor === null ? null : new Date(scheduledFor),
    manuallyScheduled: false,
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

describe("isManuallyScheduled", () => {
  const NOON = new Date("2026-08-12T09:00:00.000Z");

  it("is true for a bulk post with a time", () => {
    assert.equal(isManuallyScheduled({ scheduledFor: NOON, manuallyScheduled: true }), true);
  });

  it("is false for a cron post, however precise its time looks", () => {
    assert.equal(isManuallyScheduled({ scheduledFor: NOON, manuallyScheduled: false }), false);
  });

  it("is false for a bulk post with no time — there is nothing to honour", () => {
    assert.equal(isManuallyScheduled({ scheduledFor: null, manuallyScheduled: true }), false);
  });

  it("is false for an ordinary draft", () => {
    assert.equal(isManuallyScheduled({ scheduledFor: null, manuallyScheduled: false }), false);
  });

  it("does not depend on the clock — it is about who chose the time", () => {
    // Which is why approval can use it: whether a post is manually scheduled
    // cannot change just because its slot went by.
    const post = { scheduledFor: NOON, manuallyScheduled: true };
    assert.equal(isManuallyScheduled(post), true);
    assert.equal(decidePublish(post, new Date("2026-08-20T09:00:00.000Z")), "past_due");
    assert.equal(isManuallyScheduled(post), true);
  });
});

describe("missedItsSchedule", () => {
  const NOON = new Date("2026-08-12T09:00:00.000Z");
  const manual = { scheduledFor: NOON, manuallyScheduled: true };

  it("is false while the chosen time is still ahead", () => {
    assert.equal(missedItsSchedule(manual, new Date(NOON.getTime() - 12 * 60 * 1000)), false);
    assert.equal(missedItsSchedule(manual, new Date(NOON.getTime() - 1)), false);
  });

  it("is true at the slot itself", () => {
    // The same boundary refuseScheduleTime draws: an instant that has arrived is
    // not one a post can still be scheduled for.
    assert.equal(missedItsSchedule(manual, NOON), true);
  });

  it("is true one minute later, with no grace of its own", () => {
    // Explicitly NOT the sweep's grace. That window forgives a late TICK for a
    // post approved on time; this asks whether the APPROVAL was on time.
    assert.equal(missedItsSchedule(manual, new Date(NOON.getTime() + 60_000)), true);
  });

  it("is true inside the sweep's grace window, where decidePublish still sends", () => {
    // The two rules deliberately disagree here, and the disagreement is the
    // feature: approve at 11:59 and a 12:04 sweep still delivers; try to approve
    // at 12:04 and you are asked for a new time instead.
    const insideGrace = new Date(NOON.getTime() + PAST_DUE_GRACE_MS - 1);

    assert.equal(decidePublish(manual, insideGrace), "publish");
    assert.equal(missedItsSchedule(manual, insideGrace), true);
  });

  it("is true far past the slot", () => {
    assert.equal(missedItsSchedule(manual, new Date("2026-09-01T09:00:00.000Z")), true);
  });

  it("is false for a cron estimate, however late — nobody promised that time", () => {
    assert.equal(
      missedItsSchedule({ scheduledFor: NOON, manuallyScheduled: false }, new Date("2026-09-01")),
      false
    );
  });

  it("is false for a post with no time to miss", () => {
    assert.equal(
      missedItsSchedule({ scheduledFor: null, manuallyScheduled: true }, new Date("2026-09-01")),
      false
    );
    assert.equal(
      missedItsSchedule({ scheduledFor: null, manuallyScheduled: false }, new Date("2026-09-01")),
      false
    );
  });
});

describe("blocksOnDemandPublish", () => {
  const NOON = new Date("2026-08-12T09:00:00.000Z");
  const manual = { scheduledFor: NOON, manuallyScheduled: true };

  it("blocks a manual post at every moment in its life", () => {
    // Before the slot, exactly on it, four minutes past it, and days past it.
    // The card is refused throughout, while the sweep's own view of each moment
    // (decidePublish, untouched) still varies — which is the whole design: one
    // actor publishes these, and it is not the card.
    const moments: Array<[string, Date, string]> = [
      ["twelve minutes early", new Date(NOON.getTime() - 12 * 60 * 1000), "not_due"],
      ["one millisecond early", new Date(NOON.getTime() - 1), "not_due"],
      ["exactly on time", NOON, "publish"],
      // The bypass this closes: a 12:00 post approved at 12:04 used to be
      // sendable by hand because it had technically become due, which reads to
      // whoever set 12:00 as "approving published it immediately".
      ["four minutes late, inside the grace", new Date(NOON.getTime() + 4 * 60 * 1000), "publish"],
      ["days late, past the grace", new Date("2026-08-14T09:00:00.000Z"), "past_due"],
    ];

    for (const [label, now, sweepDecision] of moments) {
      assert.equal(decidePublish(manual, now), sweepDecision, `sweep, ${label}`);
      assert.equal(blocksOnDemandPublish(manual), true, `card must be refused ${label}`);
    }
  });

  it("keeps the sweep's grace intact — the recovery logic is not removed", () => {
    // A post inside the grace is still DELIVERED, just by the sweep. Past the
    // grace the sweep still parks it, and the way out is a reschedule (the
    // schedule panel says so) rather than an immediate hand publish.
    const insideGrace = new Date(NOON.getTime() + PAST_DUE_GRACE_MS - 1);
    const pastGrace = new Date(NOON.getTime() + PAST_DUE_GRACE_MS + 1);

    assert.equal(decidePublish(manual, insideGrace), "publish");
    assert.equal(decidePublish(manual, pastGrace), "past_due");
  });

  it("allows an unscheduled post, which is the ordinary publish-now case", () => {
    // decidePublish calls this "not_due" forever; on demand it is the norm.
    assert.equal(decidePublish({ scheduledFor: null, manuallyScheduled: false }, NOON), "not_due");
    assert.equal(blocksOnDemandPublish({ scheduledFor: null, manuallyScheduled: false }), false);
  });

  it("allows an unscheduled post that came from a bulk run", () => {
    assert.equal(blocksOnDemandPublish({ scheduledFor: null, manuallyScheduled: true }), false);
  });

  it("never blocks an automatic post, however far out its estimate is", () => {
    // Nobody promised a cron time, so on-demand publishing stays exactly as it
    // was for these — including the 48-hour look-ahead.
    assert.equal(blocksOnDemandPublish({ scheduledFor: NOON, manuallyScheduled: false }), false);
  });
});
