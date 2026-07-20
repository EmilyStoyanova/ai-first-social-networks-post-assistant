/**
 * Which actions a post card offers, given who is looking and where the post is.
 *
 * The workflow in the data model is unchanged — draft → pending_approval →
 * approved → sent_to_buffer, with every transition still recorded (see
 * post-approval.service.ts). What changes here is how much of it each role has
 * to operate by hand:
 *
 *   • An EDITOR cannot approve or publish, so their one action is handing the
 *     draft to an owner: "Submit for approval".
 *
 *   • An OWNER holds both rights already. Making them submit a post to
 *     themselves, approve it, and then publish it is three clicks to express one
 *     decision — "this should go out". So an owner gets a single primary action
 *     that approves (when approval is still outstanding) and publishes in one
 *     step; see approveAndPublishPost.
 *
 * Intermediate transitions an owner would only be performing to satisfy the
 * state machine are therefore not offered to them. Rejecting is not one of
 * those: it is a real editorial decision about someone else's work, so it stays.
 */

/** The acting user's effective role. A global admin is treated as an owner. */
export type PostRole = "owner" | "editor";

/** Uppercase PostItem.status, as the client sees it. */
export type PostStatusValue =
  | "DRAFT"
  | "PENDING_APPROVAL"
  | "APPROVED"
  | "REJECTED"
  | "SENT_TO_BUFFER"
  | "PUBLISHED"
  | "FAILED";

export interface PostActionsInput {
  role: PostRole;
  status: string;
  /** Whether the company has a Buffer connection to publish through. */
  bufferConnected: boolean;
}

export interface PostActions {
  /** Editor's hand-off to an owner. Owners never see it — they approve directly. */
  submitForApproval: boolean;
  /** The owner's single primary action: approve if needed, then send to Buffer. */
  approveAndPublish: boolean;
  /**
   * Whether that action still has to approve, which is what its label says.
   * False for an already-approved post — including one auto-approved by a
   * fully_automated channel — where only publishing is left to do.
   */
  approvalPending: boolean;
  /** Owner's answer to an editor's submission. */
  reject: boolean;
  /** Owner could publish, but Buffer is not connected yet. */
  connectBufferHint: boolean;
}

/**
 * Statuses an owner may still send to Buffer.
 *
 * `approved` covers the fully_automated channel, whose posts are approved at
 * generation with no human approver. `rejected` is absent deliberately: an owner
 * turned that post down, so publishing it is not a click away.
 */
const PUBLISHABLE: ReadonlySet<string> = new Set(["DRAFT", "PENDING_APPROVAL", "APPROVED"]);

export function resolvePostActions({
  role,
  status,
  bufferConnected,
}: PostActionsInput): PostActions {
  if (role === "editor") {
    return {
      // An editor's draft is the only thing they can move, and only to an owner.
      submitForApproval: status === "DRAFT",
      approveAndPublish: false,
      approvalPending: false,
      reject: false,
      // Buffer is not an editor's concern — they cannot publish either way.
      connectBufferHint: false,
    };
  }

  const publishable = PUBLISHABLE.has(status);
  return {
    // An owner approving their own submission is a formality; skip straight to
    // the decision that matters.
    submitForApproval: false,
    approveAndPublish: publishable && bufferConnected,
    approvalPending: publishable && status !== "APPROVED",
    reject: status === "PENDING_APPROVAL",
    connectBufferHint: publishable && !bufferConnected,
  };
}
