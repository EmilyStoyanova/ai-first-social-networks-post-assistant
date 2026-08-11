import { prisma } from "@/lib/db/client";
import { createAuditLog, AUDIT_ACTIONS } from "@/lib/services/audit/audit-log.service";
import { pastDueMessage } from "@/lib/scheduling/publish-window";
import { refuseReschedule } from "@/lib/scheduling/reschedule-policy";

/**
 * Giving a post a new publish time.
 *
 * This is the way out of a missed slot. The publisher refuses to fire a manually
 * scheduled post long after its time (lib/scheduling/publish-window.ts), which
 * would leave such a post stranded forever if nothing could move it — so this
 * service exists to be that one thing, and it only ever moves a post FORWARD.
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
  generationBatchId: string | null;
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
      generationBatchId: true,
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
 * Moves a post's `scheduledFor` to a new instant in the future.
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
      from: previous?.toISOString() ?? null,
      to: when.toISOString(),
      status: ctx.post.status,
      generationBatchId: ctx.post.generationBatchId,
    },
  });

  return { success: true, scheduledFor: when.toISOString() };
}
