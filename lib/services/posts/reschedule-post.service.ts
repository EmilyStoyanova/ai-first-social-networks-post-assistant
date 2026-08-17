import { prisma } from "@/lib/db/client";
import { createAuditLog, AUDIT_ACTIONS } from "@/lib/services/audit/audit-log.service";
import { pastDueMessage } from "@/lib/scheduling/publish-window";
import { refuseReschedule } from "@/lib/scheduling/reschedule-policy";

/**
 * Giving a post a publish time — its first, or a replacement for one.
 *
 * Two jobs, deliberately one service. It is the way out of a missed slot: the
 * publisher refuses to fire a manually scheduled post long after its time
 * (lib/scheduling/publish-window.ts), which would leave such a post stranded
 * forever if nothing could move it. And it is how an unscheduled draft gets a
 * time at all, from the Schedule control on its card.
 *
 * They are the same write, so they are the same service — "set this post's
 * publish time to this instant" is one operation whether or not the column
 * already held something, and splitting it would give scheduling two entry
 * points that could disagree about who may do it and to when. The only
 * difference is what the audit entry's `from` reads.
 *
 * Either way the post comes out MANUALLY SCHEDULED, which is the load-bearing
 * half: a time nobody chose may be brought forward by up to 48 hours, and one a
 * person typed into a picker must not be. Scheduling does not touch `status` —
 * a draft stays a draft, a pending post stays pending, and approval remains a
 * separate decision that the sweep waits for.
 *
 * The rule itself lives in lib/scheduling/reschedule-policy.ts so the card can
 * apply the same one before offering the control; re-exported here because this
 * service is where callers look for it.
 */

export { refuseReschedule };
export type { RescheduleRefusal } from "@/lib/scheduling/reschedule-policy";

export interface ReschedulePostInput {
  /** The new publish time, as an ISO-8601 instant. */
  scheduledFor: string;
}

export type ReschedulePostResult =
  | { success: true; scheduledFor: string }
  | { success: false; code: "NOT_FOUND" }
  | { success: false; code: "FORBIDDEN" }
  | { success: false; code: "POST_LOCKED"; message: string }
  | { success: false; code: "INVALID_SCHEDULE"; message: string };

interface PostContext {
  companyId: string;
  status: string;
  scheduledFor: Date | null;
  lastError: string | null;
  manuallyScheduled: boolean;
}

async function resolveContext(
  postId: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<{ ok: false; code: "NOT_FOUND" } | { ok: true; post: PostContext; isOwner: boolean }> {
  const post = await prisma.post.findUnique({
    where: { id: postId },
    select: {
      companyId: true,
      status: true,
      scheduledFor: true,
      lastError: true,
      manuallyScheduled: true,
    },
  });
  if (!post) return { ok: false, code: "NOT_FOUND" };

  if (isGlobalAdmin) return { ok: true, post, isOwner: true };

  const membership = await prisma.companyMember.findFirst({
    where: { companyId: post.companyId, userId },
    select: { role: true },
  });
  if (!membership) return { ok: false, code: "NOT_FOUND" };

  return { ok: true, post, isOwner: membership.role === "owner" };
}

/**
 * Sets a post's `scheduledFor` to an instant in the future.
 *
 * `now` is injectable so the boundary can be tested without sleeping.
 */
export async function reschedulePost(
  postId: string,
  userId: string,
  isGlobalAdmin: boolean,
  input: ReschedulePostInput,
  deps: { now?: () => Date } = {}
): Promise<ReschedulePostResult> {
  const now = (deps.now ?? (() => new Date()))();
  const when = new Date(input.scheduledFor);

  const ctx = await resolveContext(postId, userId, isGlobalAdmin);
  if (!ctx.ok) return { success: false, code: ctx.code };

  const refusal = refuseReschedule(ctx.post, ctx.isOwner, when, now);
  if (refusal !== null) return { success: false, ...refusal };

  const previous = ctx.post.scheduledFor;

  await prisma.post.update({
    where: { id: postId },
    data: {
      scheduledFor: when,
      // A person just picked this time, so it is one the publisher must keep
      // rather than an estimate it may bring forward. Written on every call, not
      // only when the post had no time before: an automatic post whose estimate
      // somebody deliberately overrode is now hand-scheduled too, and leaving
      // the flag alone would let the sweep send it up to 48 hours early — the
      // exact instruction the user was overriding.
      manuallyScheduled: true,
      // Clears the publisher's "you missed this slot" note, and only that note:
      // a real delivery error belongs to the retry step and is not ours to erase.
      ...(previous !== null && ctx.post.lastError === pastDueMessage(previous)
        ? { lastError: null }
        : {}),
    },
  });

  await createAuditLog({
    companyId: ctx.post.companyId,
    userId,
    action: AUDIT_ACTIONS.POST_RESCHEDULED,
    entityType: "post",
    entityId: postId,
    metadata: {
      // Null when the post had no time at all — this was its first schedule
      // rather than a move, which is the one thing the entry cannot say twice.
      from: previous?.toISOString() ?? null,
      to: when.toISOString(),
      status: ctx.post.status,
      wasManuallyScheduled: ctx.post.manuallyScheduled,
    },
  });

  return { success: true, scheduledFor: when.toISOString() };
}
