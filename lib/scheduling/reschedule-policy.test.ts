import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canReschedule, refuseReschedule, refuseScheduleTime } from "./reschedule-policy";

const NOW = new Date("2026-08-20T07:00:00.000Z");
const FUTURE = new Date("2026-08-25T09:00:00.000Z");
const PAST = new Date("2026-08-19T09:00:00.000Z");

describe("refuseReschedule — which posts may be moved", () => {
  it("allows a draft to be given a future time", () => {
    assert.equal(refuseReschedule({ status: "draft" }, false, FUTURE, NOW), null);
  });

  it("allows a pending or rejected post to be moved by any member", () => {
    // Nothing publishes from these states, so an editor changing the date
    // changes nothing about what goes out.
    assert.equal(refuseReschedule({ status: "pending_approval" }, false, FUTURE, NOW), null);
    assert.equal(refuseReschedule({ status: "rejected" }, false, FUTURE, NOW), null);
  });

  it("lets an owner move an approved post — the way out of a missed slot", () => {
    assert.equal(refuseReschedule({ status: "approved" }, true, FUTURE, NOW), null);
  });

  it("refuses an editor moving an approved post", () => {
    // An approved post is one sweep away from publishing, so when it goes out is
    // the same decision as whether it goes out.
    assert.deepEqual(refuseReschedule({ status: "approved" }, false, FUTURE, NOW), {
      code: "FORBIDDEN",
    });
  });

  it("refuses a post that has already reached Buffer", () => {
    const refusal = refuseReschedule({ status: "sent_to_buffer" }, true, FUTURE, NOW);
    assert.equal(refusal?.code, "SCHEDULE_LOCKED");
  });

  it("refuses a published post", () => {
    assert.equal(
      refuseReschedule({ status: "published" }, true, FUTURE, NOW)?.code,
      "SCHEDULE_LOCKED"
    );
  });

  it("refuses a failed post, whose retry budget owns it", () => {
    // Rescheduling a failed post would not re-attempt delivery anyway — the
    // retry step keys off status, not time — so offering it would only mislead.
    assert.equal(
      refuseReschedule({ status: "failed" }, true, FUTURE, NOW)?.code,
      "SCHEDULE_LOCKED"
    );
  });

  it("reports what the post actually is, so a stale card can repaint", () => {
    // The half that ends the retry loop. This refusal is normally reached by a
    // card that has gone stale — the publishing sweep moved the post while the
    // page sat open — so the answer has to carry enough for the client to stop
    // offering the control, not merely to refuse this one attempt.
    //
    // Uppercase, matching `PostItem.status`, which is what the card compares
    // against; the database's own value is lowercase.
    for (const [stored, expected] of [
      ["sent_to_buffer", "SENT_TO_BUFFER"],
      ["published", "PUBLISHED"],
      ["failed", "FAILED"],
    ]) {
      const refusal = refuseReschedule({ status: stored }, true, FUTURE, NOW);
      assert.equal(refusal?.code, "SCHEDULE_LOCKED", stored);
      assert.equal(refusal.code === "SCHEDULE_LOCKED" && refusal.status, expected);
    }
  });

  it("says rescheduling, not editing", () => {
    // Why this is not the shared POST_LOCKED: that code's translation reads
    // "this post is locked and cannot be edited", which is true for the edit and
    // restore routes and simply wrong for someone moving a publish time.
    const refusal = refuseReschedule({ status: "sent_to_buffer" }, true, FUTURE, NOW);
    assert.equal(refusal?.code, "SCHEDULE_LOCKED");
    assert.match(refusal?.code === "SCHEDULE_LOCKED" ? refusal.message : "", /rescheduled/);
  });
});

describe("refuseReschedule — the new time must be in the future", () => {
  it("refuses a time that has already passed", () => {
    // The safety property: a past time would land straight back inside the
    // publisher's grace window and go out at once, which is the silent late
    // publish the whole policy exists to prevent.
    const refusal = refuseReschedule({ status: "approved" }, true, PAST, NOW);
    assert.equal(refusal?.code, "INVALID_SCHEDULE");
  });

  it("refuses the current instant", () => {
    assert.equal(
      refuseReschedule({ status: "approved" }, true, new Date(NOW), NOW)?.code,
      "INVALID_SCHEDULE"
    );
  });

  it("accepts one millisecond into the future", () => {
    assert.equal(
      refuseReschedule({ status: "approved" }, true, new Date(NOW.getTime() + 1), NOW),
      null
    );
  });

  it("refuses an unparseable date", () => {
    const refusal = refuseReschedule({ status: "draft" }, true, new Date("not-a-date"), NOW);
    assert.equal(refusal?.code, "INVALID_SCHEDULE");
  });
});

describe("refuseReschedule — the order of the checks", () => {
  it("reports the lock, not the date, for a post nobody may move", () => {
    // "You cannot touch this post" is a truer answer than "pick a later time"
    // for something already published.
    assert.equal(
      refuseReschedule({ status: "published" }, true, PAST, NOW)?.code,
      "SCHEDULE_LOCKED"
    );
  });

  it("reports permission before the date for an editor on an approved post", () => {
    assert.equal(refuseReschedule({ status: "approved" }, false, PAST, NOW)?.code, "FORBIDDEN");
  });

  it("reports a malformed date before anything else", () => {
    // Nothing else can be judged without knowing what time was meant.
    assert.equal(
      refuseReschedule({ status: "published" }, false, new Date("nope"), NOW)?.code,
      "INVALID_SCHEDULE"
    );
  });
});

describe("canReschedule — whether the card offers the control", () => {
  it("agrees with refuseReschedule on every status, for both roles", () => {
    // The card must not offer a control the server will refuse, nor hide one it
    // would accept. Checked against the real rule rather than a second list.
    const statuses = [
      "draft",
      "pending_approval",
      "rejected",
      "approved",
      "sent_to_buffer",
      "published",
      "failed",
    ];
    for (const status of statuses) {
      for (const isOwner of [true, false]) {
        assert.equal(
          canReschedule(status, isOwner),
          refuseReschedule({ status }, isOwner, FUTURE, NOW) === null,
          `${status} / ${isOwner ? "owner" : "editor"}`
        );
      }
    }
  });

  it("accepts the uppercase status the client holds", () => {
    // PostItem uppercases status for display; the database does not.
    assert.equal(canReschedule("DRAFT", false), true);
    assert.equal(canReschedule("APPROVED", true), true);
    assert.equal(canReschedule("APPROVED", false), false);
    assert.equal(canReschedule("PUBLISHED", true), false);
  });

  it("says nothing about the time, which the form has not been given yet", () => {
    // An empty form has no instant to judge — that check belongs to the submit.
    assert.equal(canReschedule("approved", true), true);
  });
});

describe("refuseScheduleTime — the half that applies to a post not yet written", () => {
  it("accepts a future instant", () => {
    assert.equal(refuseScheduleTime(FUTURE, NOW), null);
  });

  it("refuses a time that has already gone by", () => {
    // The generation form's whole reason for asking: a post written straight
    // into the past is one the publisher parks rather than sends, so the request
    // is refused before minutes of billed generation are spent on it.
    assert.deepEqual(refuseScheduleTime(PAST, NOW)?.code, "INVALID_SCHEDULE");
  });

  it("refuses the current instant, which is not in the future", () => {
    assert.deepEqual(refuseScheduleTime(NOW, NOW)?.code, "INVALID_SCHEDULE");
  });

  it("refuses an unparseable date", () => {
    assert.deepEqual(refuseScheduleTime(new Date("nonsense"), NOW)?.code, "INVALID_SCHEDULE");
  });

  it("is exactly the clock half of refuseReschedule", () => {
    // The two must never diverge: a time the generation form accepts has to be
    // one a reschedule of the resulting post would accept as well. Checked on a
    // status whose permission half always passes, so only the clock is in play.
    for (const when of [FUTURE, PAST, NOW, new Date("nonsense")]) {
      assert.deepEqual(
        refuseReschedule({ status: "draft" }, false, when, NOW),
        refuseScheduleTime(when, NOW),
        when.toString()
      );
    }
  });
});
