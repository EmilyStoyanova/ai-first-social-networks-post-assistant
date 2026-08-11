import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canReschedule, refuseReschedule } from "./reschedule-policy";

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
    assert.equal(refusal?.code, "POST_LOCKED");
  });

  it("refuses a published post", () => {
    assert.equal(refuseReschedule({ status: "published" }, true, FUTURE, NOW)?.code, "POST_LOCKED");
  });

  it("refuses a failed post, whose retry budget owns it", () => {
    // Rescheduling a failed post would not re-attempt delivery anyway — the
    // retry step keys off status, not time — so offering it would only mislead.
    assert.equal(refuseReschedule({ status: "failed" }, true, FUTURE, NOW)?.code, "POST_LOCKED");
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
    assert.equal(refuseReschedule({ status: "published" }, true, PAST, NOW)?.code, "POST_LOCKED");
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
