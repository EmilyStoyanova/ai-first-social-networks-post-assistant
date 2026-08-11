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
 *
 * The one exception to "approve and publish are one decision" is a post whose
 * time a person chose (a manual bulk post, still ahead of its slot). There they
 * are two decisions — approve it now, publish it at 12:00 — so the owner is
 * offered approval alone and the sweep does the rest.
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
  /** True iff a person named this post's time — PostItem.manuallyScheduled. */
  manuallyScheduled?: boolean;
  /** The named time, ISO, as the client holds it. */
  scheduledFor?: string | null;
  /** Evaluated against `scheduledFor`. Passed in so this stays pure. */
  now?: Date;
}

export interface PostActions {
  /** Editor's hand-off to an owner. Owners never see it — they approve directly. */
  submitForApproval: boolean;
  /** The owner's single primary action: approve if needed, then send to Buffer. */
  approveAndPublish: boolean;
  /**
   * Approve WITHOUT publishing — the owner's action on a post whose time a
   * person set for later. Approving is genuinely all there is to do: the
   * publishing sweep sends it when it is due, so offering "publish" here would
   * offer to break the schedule (and the server refuses it — NOT_DUE).
   */
  approveOnly: boolean;
  /**
   * Whether the post is approved and simply waiting for its own time. No action
   * belongs to the owner in that state, so the card explains instead of asking.
   */
  awaitingSchedule: boolean;
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
  manuallyScheduled = false,
  scheduledFor = null,
  now,
}: PostActionsInput): PostActions {
  if (role === "editor") {
    return {
      // An editor's draft is the only thing they can move, and only to an owner.
      submitForApproval: status === "DRAFT",
      approveAndPublish: false,
      approveOnly: false,
      awaitingSchedule: false,
      approvalPending: false,
      reject: false,
      // Buffer is not an editor's concern — they cannot publish either way.
      connectBufferHint: false,
    };
  }

  const publishable = PUBLISHABLE.has(status);

  // Held back by its own schedule: a person set a time still in the future, so
  // publishing now is not on offer. Mirrors blocksOnDemandPublish in
  // lib/scheduling/publish-window.ts, which is what actually enforces it — this
  // only keeps the card from proposing an action the server would refuse.
  // A past-due post is NOT held: publishing it by hand is its recovery path.
  const scheduledAhead =
    manuallyScheduled &&
    scheduledFor !== null &&
    now !== undefined &&
    new Date(scheduledFor).getTime() > now.getTime();

  return {
    // An owner approving their own submission is a formality; skip straight to
    // the decision that matters.
    submitForApproval: false,
    approveAndPublish: publishable && bufferConnected && !scheduledAhead,
    approveOnly: scheduledAhead && publishable && status !== "APPROVED",
    awaitingSchedule: scheduledAhead && status === "APPROVED",
    approvalPending: publishable && status !== "APPROVED",
    reject: status === "PENDING_APPROVAL",
    // Pointless while the post is waiting for its time — the sweep needs Buffer,
    // but that is a company-settings problem, not this post's next step.
    connectBufferHint: publishable && !bufferConnected && !scheduledAhead,
  };
}
