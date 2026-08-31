import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolvePostActions } from "./post-actions";
import type { PostActionsInput } from "./post-actions";

function actions(overrides: Partial<PostActionsInput> = {}) {
  return resolvePostActions({
    role: "owner",
    status: "DRAFT",
    bufferConnected: true,
    ...overrides,
  });
}

describe("resolvePostActions — editor", () => {
  it("offers approval directly on a draft — no hand-off to an owner", () => {
    const a = actions({ role: "editor", status: "DRAFT" });

    assert.equal(a.approveOnly, true);
    // An editor can never publish, whatever the status.
    assert.equal(a.approveAndPublish, false);
    assert.equal(a.reject, false);
    assert.equal(a.connectBufferHint, false);
  });

  it("still offers approval on a pre-existing pending_approval row (backward compatibility)", () => {
    const a = actions({ role: "editor", status: "PENDING_APPROVAL" });

    assert.equal(a.approveOnly, true);
    assert.equal(a.approveAndPublish, false);
    assert.equal(a.reject, false);
  });

  it("offers nothing further once approved — there is no publish action for this role", () => {
    const a = actions({ role: "editor", status: "APPROVED" });

    assert.equal(a.approveOnly, false);
    assert.equal(a.approveAndPublish, false);
    assert.equal(a.approvalPending, false);
  });

  it("never publishes, even on an approved post with Buffer connected", () => {
    const a = actions({ role: "editor", status: "APPROVED" });

    assert.equal(a.approveAndPublish, false);
    assert.equal(a.connectBufferHint, false);
  });

  it("withholds approval on a hand-scheduled draft whose time has passed", () => {
    const a = actions({
      role: "editor",
      status: "DRAFT",
      manuallyScheduled: true,
      scheduledFor: "2026-08-12T09:00:00.000Z",
      now: new Date("2026-08-12T09:05:00.000Z"),
    });

    assert.equal(a.scheduleMissed, true);
    assert.equal(a.approveOnly, false);
  });

  it("never rejects, even a system-generated draft", () => {
    const a = actions({ role: "editor", status: "DRAFT", generatedById: null });

    assert.equal(a.reject, false);
  });
});

describe("resolvePostActions — owner", () => {
  it("offers the combined approve-and-publish action on a draft", () => {
    const a = actions({ role: "owner", status: "DRAFT" });

    assert.equal(a.approveAndPublish, true);
    assert.equal(a.approvalPending, true);
  });

  it("offers the same combined action on a post pending approval", () => {
    const a = actions({ role: "owner", status: "PENDING_APPROVAL" });

    assert.equal(a.approveAndPublish, true);
    assert.equal(a.approvalPending, true);
    // Rejecting is a real editorial decision, so it survives the simplification.
    assert.equal(a.reject, true);
  });

  it("drops the approval half once the post is already approved", () => {
    const a = actions({ role: "owner", status: "APPROVED" });

    assert.equal(a.approveAndPublish, true);
    // Nothing left to approve — the button says publish, not approve and publish.
    assert.equal(a.approvalPending, false);
  });

  it("does not offer a rejected post as a click-away publish", () => {
    const a = actions({ role: "owner", status: "REJECTED" });

    assert.equal(a.approveAndPublish, false);
    assert.equal(a.connectBufferHint, false);
    // It has to be resubmitted rather than published from the card.
    assert.equal(a.reject, false);
  });

  it("offers nothing more on a post already sent to Buffer", () => {
    const a = actions({ role: "owner", status: "SENT_TO_BUFFER" });

    assert.equal(a.approveAndPublish, false);
    assert.equal(a.approveOnly, false);
  });

  it("replaces the publish action with a hint when Buffer is not connected", () => {
    const a = actions({ role: "owner", status: "PENDING_APPROVAL", bufferConnected: false });

    assert.equal(a.approveAndPublish, false);
    assert.equal(a.connectBufferHint, true);
  });
});

// ─── Rejecting a draft ────────────────────────────────────────────────────────
// `pending_approval` no longer exists as a generation outcome — cron-generated
// posts land in `draft` exactly like manual ones. `generatedById` is the only
// thing left that tells a system draft (no human author) apart from a person's
// own work in progress, and it decides whether Reject applies to a draft.

describe("resolvePostActions — rejecting a draft", () => {
  it("lets an owner reject a system-generated draft (no human author)", () => {
    const a = actions({ role: "owner", status: "DRAFT", generatedById: null });

    assert.equal(a.reject, true);
  });

  it("does not let an owner reject their own or another human's draft", () => {
    const a = actions({ role: "owner", status: "DRAFT", generatedById: "user-1" });

    assert.equal(a.reject, false);
  });

  it("never offers reject to an editor, even on a system-generated draft", () => {
    const a = actions({ role: "editor", status: "DRAFT", generatedById: null });

    assert.equal(a.reject, false);
  });

  it("does not extend reject to a non-draft, non-pending status merely for lacking an author", () => {
    for (const status of ["APPROVED", "REJECTED", "SENT_TO_BUFFER", "PUBLISHED"]) {
      const a = actions({ role: "owner", status, generatedById: null });
      assert.equal(a.reject, false, `${status} must not offer reject`);
    }
  });
});

// ─── A post whose time a person chose ────────────────────────────────────────
// The card must not offer to publish such a post early, whether the time came
// from a bulk run or from the single-post generation form — the input is
// `manuallyScheduled` + `scheduledFor`, so there is no third case. The server
// refuses it (blocksOnDemandPublish → NOT_DUE); this keeps the button honest.

describe("resolvePostActions — manually scheduled", () => {
  const NOON = "2026-08-12T09:00:00.000Z"; // 12:00 Sofia
  const BEFORE = new Date("2026-08-12T08:48:00.000Z"); // 11:48 Sofia

  // Its time is still ahead, so approval is on offer. `now` matters only to the
  // missed-schedule question below.
  const held = (status: string) =>
    actions({ status, manuallyScheduled: true, scheduledFor: NOON, now: BEFORE });

  it("offers approval alone on a post awaiting approval", () => {
    const a = held("PENDING_APPROVAL");

    assert.equal(a.approveOnly, true);
    // The bug: this was the only action on offer, and it published immediately.
    assert.equal(a.approveAndPublish, false);
    // Rejecting is still a real editorial decision.
    assert.equal(a.reject, true);
  });

  it("offers approval alone on a draft", () => {
    const a = held("DRAFT");

    assert.equal(a.approveOnly, true);
    assert.equal(a.approveAndPublish, false);
  });

  it("offers nothing but an explanation once approved", () => {
    const a = held("APPROVED");

    assert.equal(a.approveOnly, false);
    assert.equal(a.approveAndPublish, false);
    assert.equal(a.awaitingSchedule, true);
  });

  it("drops the Buffer hint, which is not this post's next step", () => {
    const a = actions({
      status: "PENDING_APPROVAL",
      bufferConnected: false,
      manuallyScheduled: true,
      scheduledFor: NOON,
    });

    assert.equal(a.connectBufferHint, false);
    assert.equal(a.approveOnly, true);
  });

  it("still offers approval alone once the time has come", () => {
    // The sweep publishes at 12:00; the card's job is finished at "approved".
    for (const status of ["DRAFT", "PENDING_APPROVAL"]) {
      const a = held(status);

      assert.equal(a.approveOnly, true, `${status} must offer approval alone`);
      assert.equal(a.approveAndPublish, false, `${status} must not offer publishing`);
    }
  });

  it("offers publishing at no status, so the sweep is the only sender", () => {
    // The closed bypass, stated as a whole: whatever state a hand-scheduled post
    // is in, the card will not send it. Recovery for one whose slot is long gone
    // is a reschedule — the schedule panel shows it is past due and takes a new
    // time — not an immediate hand publish. There is no clock in the input any
    // more, so this cannot vary with when the card is looked at.
    for (const status of ["DRAFT", "PENDING_APPROVAL", "APPROVED"]) {
      assert.equal(held(status).approveAndPublish, false, `${status} must not offer publishing`);
    }
  });

  it("leaves an automatic post's card exactly as it was", () => {
    const a = actions({
      status: "PENDING_APPROVAL",
      manuallyScheduled: false,
      scheduledFor: NOON,
    });

    assert.equal(a.approveAndPublish, true);
    assert.equal(a.approveOnly, false);
    assert.equal(a.awaitingSchedule, false);
  });

  it("leaves an unscheduled post's card exactly as it was", () => {
    const a = actions({
      status: "PENDING_APPROVAL",
      manuallyScheduled: true,
      scheduledFor: null,
    });

    assert.equal(a.approveAndPublish, true);
    assert.equal(a.approveOnly, false);
  });

  it("offers an editor approval alone on a hand-scheduled post, never publishing", () => {
    const a = actions({
      role: "editor",
      status: "PENDING_APPROVAL",
      manuallyScheduled: true,
      scheduledFor: NOON,
    });

    // The time is still ahead (no clock supplied), so approval is on offer —
    // an editor can approve a hand-scheduled post exactly like an owner can.
    assert.equal(a.approveOnly, true);
    // Never publishing is the one thing that never changes for this role.
    assert.equal(a.approveAndPublish, false);
    assert.equal(a.awaitingSchedule, false);
    assert.equal(a.scheduleMissed, false);
  });
});

// ─── …whose time went by before anybody approved it ──────────────────────────
// Approval is withheld and a new time is asked for. The card mirrors what
// approvePost enforces (SCHEDULE_MISSED), so it never offers an approval the
// server would refuse.

describe("resolvePostActions — a missed manual schedule", () => {
  const NOON = "2026-08-12T09:00:00.000Z";
  const ONE_MINUTE_LATE = new Date("2026-08-12T09:01:00.000Z");

  const missed = (status: string, now: Date = ONE_MINUTE_LATE) =>
    actions({ status, manuallyScheduled: true, scheduledFor: NOON, now });

  it("withholds approval and flags the missed time on a draft", () => {
    const a = missed("DRAFT");

    assert.equal(a.scheduleMissed, true);
    assert.equal(a.approveOnly, false);
    // Publishing was never on offer for these and still is not.
    assert.equal(a.approveAndPublish, false);
  });

  it("withholds approval on a submitted post too", () => {
    const a = missed("PENDING_APPROVAL");

    assert.equal(a.scheduleMissed, true);
    assert.equal(a.approveOnly, false);
    // Turning it down is still a real decision, and needs no new time.
    assert.equal(a.reject, true);
  });

  it("counts the slot itself as missed", () => {
    // A post cannot be published AT a moment that has arrived — the sweep is
    // what sends it, on its next tick, and only if it was approved by now.
    const a = missed("DRAFT", new Date(NOON));

    assert.equal(a.scheduleMissed, true);
    assert.equal(a.approveOnly, false);
  });

  it("still offers approval a millisecond before the slot", () => {
    const a = missed("DRAFT", new Date(new Date(NOON).getTime() - 1));

    assert.equal(a.scheduleMissed, false);
    assert.equal(a.approveOnly, true);
  });

  it("restores approval once a future time has been chosen", () => {
    // What the card does after PostSchedulePanel reports the new instant.
    const later = new Date(ONE_MINUTE_LATE.getTime() + 60 * 60 * 1000).toISOString();
    const a = actions({
      status: "DRAFT",
      manuallyScheduled: true,
      scheduledFor: later,
      now: ONE_MINUTE_LATE,
    });

    assert.equal(a.scheduleMissed, false);
    assert.equal(a.approveOnly, true);
  });

  it("leaves an already-approved post out of it — the sweep's grace is its business", () => {
    // This post was approved before its slot, so a late sweep is what it is
    // waiting on. Demanding a reschedule here would undo the recovery the grace
    // window exists to provide.
    const a = missed("APPROVED");

    assert.equal(a.scheduleMissed, false);
    assert.equal(a.awaitingSchedule, true);
    assert.equal(a.approveAndPublish, false);
  });

  it("says nothing is missed when no clock is supplied", () => {
    // The server-render answer: no comparison is made, so the card renders the
    // same markup it will hydrate into. The approve route is the real gate.
    const a = actions({ status: "DRAFT", manuallyScheduled: true, scheduledFor: NOON });

    assert.equal(a.scheduleMissed, false);
    assert.equal(a.approveOnly, true);
  });

  it("never flags a cron post, whose time nobody promised", () => {
    const a = actions({
      status: "PENDING_APPROVAL",
      manuallyScheduled: false,
      scheduledFor: NOON,
      now: ONE_MINUTE_LATE,
    });

    assert.equal(a.scheduleMissed, false);
    assert.equal(a.approveAndPublish, true);
  });

  it("never flags an unscheduled post, which has no time to miss", () => {
    const a = actions({
      status: "PENDING_APPROVAL",
      manuallyScheduled: true,
      scheduledFor: null,
      now: ONE_MINUTE_LATE,
    });

    assert.equal(a.scheduleMissed, false);
    assert.equal(a.approveAndPublish, true);
  });
});
