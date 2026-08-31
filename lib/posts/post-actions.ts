/**
 * Which actions a post card offers, given who is looking and where the post is.
 *
 * The workflow is now draft → approved → sent_to_buffer, with every transition
 * still recorded (see post-approval.service.ts). `pending_approval` is not a
 * step in it any more — see that file and lib/posts/post-status-filter.ts for
 * why it still exists as a status (backward compatibility only). What differs
 * between roles is PUBLISHING, not approving:
 *
 *   • An EDITOR may review and approve a draft directly — draft → approved,
 *     one action, the same one-step approval an owner gets. There used to be a
 *     mandatory hand-off first ("Submit for approval", landing the post in
 *     `pending_approval` for an owner alone to approve). That step is gone.
 *     What an editor still cannot do is publish: `approveAndPublish` is always
 *     false for this role, and the server enforces the same thing
 *     independently in approveAndPublishPost — this file only decides what the
 *     CARD offers, never what the API accepts.
 *
 *   • An OWNER holds both rights. Making them approve a post and then publish
 *     it as two separate clicks would ask them to perform a state-machine step
 *     that expresses no decision of their own — "this should go out" is one
 *     decision, not two. So an owner gets a single primary action that
 *     approves (when approval is still outstanding) and publishes in one step;
 *     see approveAndPublishPost. An already-approved post — including one an
 *     editor just approved — needs only the publish half, which the same
 *     action still offers.
 *
 * Rejecting is not folded into either of the above: it is a real editorial
 * decision about someone else's work (an editor's submission under the old
 * workflow, a system-generated draft nobody wants), so it stays its own
 * owner-only action.
 *
 * The one exception to "approve and publish are one decision" is a post whose
 * time a person chose — in a bulk run, in the single-post generation form, or
 * from the card. There they are two decisions taken by two actors: whoever
 * approves it, and the publishing sweep, which sends it at the chosen time.
 * So approval alone is offered (to either role), and the card never publishes
 * such a post itself.
 *
 * And if that time has already gone by with nobody approving it, there is no
 * decision left to take on the post as it stands: a new time is asked for
 * first (`scheduleMissed`), because approving would otherwise commit the post
 * to a publish at a moment nobody named.
 */

import { missedItsSchedule } from "@/lib/scheduling/publish-window";

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
  /**
   * PostItem.generatedById — null for a cron/system post, a user id for a
   * manual or bulk one. Read only to decide `reject` on a DRAFT: a system
   * draft may be rejected like a submission; a human's own draft may not.
   */
  generatedById?: string | null;
  /** The named time, ISO, as the client holds it. */
  scheduledFor?: string | null;
  /**
   * The current instant, for the one question that needs it: has a hand-chosen
   * time already gone by? Nothing else here reads a clock.
   *
   * Optional, and omitting it reports the schedule as NOT missed. That is the
   * server-render answer: the server's clock is not the viewer's, so comparing
   * during SSR would render one action and hydrate another (React #418). The card
   * passes a clock only once hydrated, and the approve route enforces the rule
   * regardless — so the worst an omitted clock can do is offer an Approve that
   * comes back as SCHEDULE_MISSED.
   */
  now?: Date;
}

export interface PostActions {
  /**
   * The owner's single primary action: approve if needed, then send to
   * Buffer. Always false for an editor — publishing is never offered to that
   * role, whatever the post's status.
   */
  approveAndPublish: boolean;
  /**
   * Approve WITHOUT publishing. For an owner, this is the action on a post
   * whose time a person set for later — the publishing sweep sends it when
   * due, so offering "publish" here would offer to break the schedule (and
   * the server refuses it — NOT_DUE). For an EDITOR, this is simply the whole
   * approval action on any draft (or pre-existing pending_approval row):
   * `approveAndPublish` never applies to that role, so this is the only route
   * an editor has from draft to approved.
   */
  approveOnly: boolean;
  /**
   * Whether the post is approved and simply waiting for its own time. No action
   * belongs to the owner in that state, so the card explains instead of asking.
   */
  awaitingSchedule: boolean;
  /**
   * Whether a hand-chosen publish time went by before anybody approved the post.
   *
   * Approval is withheld — `approveOnly` is false — because that moment cannot be
   * honoured any more. The card says so and points at Reschedule, which is the
   * one action that makes the post approvable again. `approvePost` enforces the
   * same rule (SCHEDULE_MISSED).
   */
  scheduleMissed: boolean;
  /**
   * Whether that action still has to approve, which is what its label says.
   * False for an already-approved post — including one auto-approved by a
   * fully_automated channel — where only publishing is left to do.
   */
  approvalPending: boolean;
  /**
   * Owner's answer to an editor's submission — OR to a system-generated draft
   * the owner does not want. `pending_approval` covers the first; a `draft`
   * with no human author (`generatedById` null) covers the second, now that
   * cron-generated posts land in `draft` like any other. An editor's OWN
   * unfinished draft never offers this — there is nothing to reject about work
   * nobody has submitted yet, and the natural action there is deleting it.
   */
  reject: boolean;
  /** Owner could publish, but Buffer is not connected yet. */
  connectBufferHint: boolean;
}

/**
 * Statuses a post may still be sent to Buffer from, or — for `approveOnly` —
 * simply approved from. `PENDING_APPROVAL` is kept only for pre-existing rows;
 * no active workflow creates a new one (see post-approval.service.ts).
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
  generatedById = null,
  now,
}: PostActionsInput): PostActions {
  const publishable = PUBLISHABLE.has(status);

  // A person chose this post's time, so the SWEEP publishes it and this card
  // never does. Mirrors blocksOnDemandPublish in lib/scheduling/publish-window.ts,
  // which is what actually enforces it — this only keeps the card from proposing
  // an action the server would refuse.
  //
  // No clock is consulted, and that is deliberate: the rule holds before the
  // slot, at it, and after it. Comparing against a `now` was what let a post a
  // few minutes past its slot quietly turn back into "Approve & publish", which
  // is the bypass this closes. A post whose slot is long gone is recovered by
  // rescheduling it (the schedule panel says so), not by publishing it by hand.
  const sweepOwnsPublish = manuallyScheduled && scheduledFor !== null;

  // …and whether the time it is waiting for has already gone by. Asked through
  // the same predicate the approve route enforces, so the card cannot offer an
  // approval the server would refuse. Only relevant while approval is still
  // outstanding — DRAFT or (a pre-existing) PENDING_APPROVAL, which is exactly
  // what `publishable && status !== "APPROVED"` reduces to — and the grace
  // window exists precisely to absorb a late sweep tick for an approved one.
  const awaitingApproval = sweepOwnsPublish && publishable && status !== "APPROVED";
  const scheduleMissed =
    awaitingApproval &&
    now !== undefined &&
    missedItsSchedule(
      { scheduledFor: new Date(scheduledFor as string), manuallyScheduled: true },
      now
    );

  if (role === "editor") {
    // A draft (or a pre-existing pending_approval row) goes straight to
    // approved — no hand-off to an owner exists any more. `scheduleMissed`
    // withholds it exactly as it would for an owner: approving a post whose
    // hand-chosen time has already passed would commit it to a moment nobody
    // named, and `approvePost` refuses it either way (SCHEDULE_MISSED).
    const awaitingEditorApproval = status === "DRAFT" || status === "PENDING_APPROVAL";
    return {
      // Never offered to this role, whatever the status — publishing is
      // owner/admin-only, enforced independently by approveAndPublishPost.
      approveAndPublish: false,
      approveOnly: awaitingEditorApproval && !scheduleMissed,
      awaitingSchedule: sweepOwnsPublish && status === "APPROVED",
      scheduleMissed,
      // Never "pending on ME to publish" — an editor is never the one who
      // finishes a post's lifecycle.
      approvalPending: false,
      // An editor never rejects — that is a decision about someone else's
      // work (or the system's), and stays owner-only.
      reject: false,
      // Buffer is not an editor's concern — they cannot publish either way.
      connectBufferHint: false,
    };
  }

  return {
    approveAndPublish: publishable && bufferConnected && !sweepOwnsPublish,
    // Withheld until the post has a time that can still be honoured.
    approveOnly: awaitingApproval && !scheduleMissed,
    awaitingSchedule: sweepOwnsPublish && status === "APPROVED",
    scheduleMissed,
    approvalPending: publishable && status !== "APPROVED",
    reject: status === "PENDING_APPROVAL" || (status === "DRAFT" && generatedById === null),
    // Pointless while the post is waiting for its time — the sweep needs Buffer,
    // but that is a company-settings problem, not this post's next step.
    connectBufferHint: publishable && !bufferConnected && !sweepOwnsPublish,
  };
}
