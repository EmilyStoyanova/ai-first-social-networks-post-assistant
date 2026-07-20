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
