/**
 * Who may move a post's publish time, and to when.
 *
 * Pure and isomorphic on purpose: the card decides whether to offer the control
 * and the service decides whether to honour the request, and those two answers
 * must never disagree. Keeping the rule here — rather than in the service, which
 * imports Prisma — is what lets the browser ask the same question the server
 * will.
 */

/** Statuses whose schedule can still mean anything. */
const RESCHEDULABLE_STATUSES = new Set(["draft", "pending_approval", "rejected", "approved"]);

/**
 * Statuses that require the authority to approve.
 *
 * An approved post is one decision away from going out, so changing when that
 * happens is an owner's call. Anything earlier is still being worked on, and an
 * editor moving a draft's date changes nothing about what gets published.
 */
const OWNER_ONLY_STATUSES = new Set(["approved"]);

/** Why a reschedule was refused, or null when it is allowed. */
export type RescheduleRefusal =
  | { code: "POST_LOCKED"; message: string }
  | { code: "FORBIDDEN" }
  | { code: "INVALID_SCHEDULE"; message: string };

/**
 * The whole rule, with no database in it: may this person move this post to this
 * time? Separated from the service so every branch is directly testable, and so
 * the order of the checks is visible in one place — status and permission are
 * decided before the clock, because "you may not touch this post" is a better
 * answer than "pick a later time" for a post that is already published.
 */
export function refuseReschedule(
  post: { status: string },
  isOwner: boolean,
  when: Date,
  now: Date
): RescheduleRefusal | null {
  if (Number.isNaN(when.getTime())) {
    return { code: "INVALID_SCHEDULE", message: "That is not a valid date." };
  }

  if (!RESCHEDULABLE_STATUSES.has(post.status)) {
    return {
      code: "POST_LOCKED",
      message: `Posts with status ${post.status.toUpperCase()} cannot be rescheduled.`,
    };
  }

  if (OWNER_ONLY_STATUSES.has(post.status) && !isOwner) {
    return { code: "FORBIDDEN" };
  }

  // The safety property. Accepting a past time would put the post straight back
  // inside the publisher's grace window, turning "this missed its slot, choose a
  // new one" into "publish it immediately" — the exact silent late publish the
  // past-due policy exists to prevent.
  if (when.getTime() <= now.getTime()) {
    return {
      code: "INVALID_SCHEDULE",
      message:
        "Pick a time in the future — a post cannot be scheduled for a moment that has passed.",
    };
  }

  return null;
}

/**
 * The status/permission half of the rule, for deciding whether to show the
 * control at all. The time itself is not checked here — a form the user has not
 * filled in yet has no time to check.
 *
 * Case-insensitive because the client sees uppercase statuses (PostItem) while
 * the database stores lowercase ones.
 */
export function canReschedule(status: string, isOwner: boolean): boolean {
  const s = status.toLowerCase();
  if (!RESCHEDULABLE_STATUSES.has(s)) return false;
  return !OWNER_ONLY_STATUSES.has(s) || isOwner;
}
