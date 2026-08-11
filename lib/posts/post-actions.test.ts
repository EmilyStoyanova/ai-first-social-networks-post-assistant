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
  it("offers only the hand-off to an owner on a draft", () => {
    const a = actions({ role: "editor", status: "DRAFT" });

    assert.equal(a.submitForApproval, true);
    // An editor holds neither right, so nothing else is on the card.
    assert.equal(a.approveAndPublish, false);
    assert.equal(a.reject, false);
    assert.equal(a.connectBufferHint, false);
  });

  it("offers nothing once the draft is pending an owner's decision", () => {
    const a = actions({ role: "editor", status: "PENDING_APPROVAL" });

    // The ball is in the owner's court — resubmitting would be a no-op.
    assert.equal(a.submitForApproval, false);
    assert.equal(a.approveAndPublish, false);
    assert.equal(a.reject, false);
  });

  it("never publishes, even on an approved post with Buffer connected", () => {
    const a = actions({ role: "editor", status: "APPROVED" });

    assert.equal(a.approveAndPublish, false);
    assert.equal(a.connectBufferHint, false);
  });
});

describe("resolvePostActions — owner", () => {
  it("skips submit-then-approve on a draft and offers the combined action", () => {
    const a = actions({ role: "owner", status: "DRAFT" });

    // The whole point: an owner never submits a post to themselves.
    assert.equal(a.submitForApproval, false);
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
    assert.equal(a.submitForApproval, false);
  });

  it("replaces the publish action with a hint when Buffer is not connected", () => {
    const a = actions({ role: "owner", status: "PENDING_APPROVAL", bufferConnected: false });

    assert.equal(a.approveAndPublish, false);
    assert.equal(a.connectBufferHint, true);
  });
});

// ─── A post whose time a person chose ────────────────────────────────────────
// The card must not offer to publish a manual bulk post early. The server
// refuses it (blocksOnDemandPublish → NOT_DUE); this keeps the button honest.

describe("resolvePostActions — manually scheduled", () => {
  const NOW = new Date("2026-08-12T08:48:00.000Z"); // 11:48 Sofia
  const NOON = "2026-08-12T09:00:00.000Z"; // 12:00 Sofia

  const held = (status: string) =>
    actions({ status, manuallyScheduled: true, scheduledFor: NOON, now: NOW });

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
      now: NOW,
    });

    assert.equal(a.connectBufferHint, false);
    assert.equal(a.approveOnly, true);
  });

  it("returns to approve-and-publish once the time has come", () => {
    const a = actions({
      status: "PENDING_APPROVAL",
      manuallyScheduled: true,
      scheduledFor: NOON,
      now: new Date(NOON),
    });

    assert.equal(a.approveAndPublish, true);
    assert.equal(a.approveOnly, false);
    assert.equal(a.awaitingSchedule, false);
  });

  it("lets an owner publish a post whose slot is long gone", () => {
    const a = actions({
      status: "APPROVED",
      manuallyScheduled: true,
      scheduledFor: NOON,
      now: new Date("2026-08-14T09:00:00.000Z"),
    });

    assert.equal(a.approveAndPublish, true);
    assert.equal(a.awaitingSchedule, false);
  });

  it("leaves an automatic post's card exactly as it was", () => {
    const a = actions({
      status: "PENDING_APPROVAL",
      manuallyScheduled: false,
      scheduledFor: NOON,
      now: NOW,
    });

    assert.equal(a.approveAndPublish, true);
    assert.equal(a.approveOnly, false);
  });

  it("leaves an unscheduled post's card exactly as it was", () => {
    const a = actions({
      status: "PENDING_APPROVAL",
      manuallyScheduled: true,
      scheduledFor: null,
      now: NOW,
    });

    assert.equal(a.approveAndPublish, true);
    assert.equal(a.approveOnly, false);
  });

  it("never offers an editor either action", () => {
    const a = actions({
      role: "editor",
      status: "PENDING_APPROVAL",
      manuallyScheduled: true,
      scheduledFor: NOON,
      now: NOW,
    });

    assert.equal(a.approveOnly, false);
    assert.equal(a.approveAndPublish, false);
    assert.equal(a.awaitingSchedule, false);
  });
});
