import { prisma } from "@/lib/db/client";
import type { Prisma } from "@prisma/client";
import { createAuditLog, AUDIT_ACTIONS } from "@/lib/services/audit/audit-log.service";
import { isManuallyScheduled } from "@/lib/scheduling/publish-window";

export type ApprovalError = "NOT_FOUND" | "FORBIDDEN" | "INVALID_TRANSITION";

export type ApprovalResult =
  { success: true; status: string } | { success: false; code: ApprovalError; message?: string };

/**
 * Which posts `approvePost` will move to `approved`.
 *
 *   • `pending_approval` — the workflow's own step. Somebody handed the post over
 *     for review, and this is that review.
 *
 *   • `draft`, but ONLY when a person already chose the post's publish time.
 *     Those are created as drafts and nobody submits them, so the sole route to
 *     `approved` was the card's publish button — which sends to Buffer
 *     immediately and so cannot be used on a post scheduled for 12:00 without
 *     breaking the schedule it was given. Approval really is the whole action
 *     for these: the publishing sweep sends them once due.
 *
 * Deliberately NOT opened to drafts in general. For every other post approving
 * and publishing remain one decision, taken through approveAndPublishPost (see
 * lib/posts/post-actions.ts), and an ordinary draft still reaches `approved` only
 * by being submitted first. Widening it would also quietly hand cron drafts to
 * the publisher's 48-hour look-ahead, which is not this change's business.
 */
export function canApprove(post: {
  status: string;
  scheduledFor: Date | null;
  manuallyScheduled: boolean;
}): boolean {
  if (post.status === "pending_approval") return true;
  return post.status === "draft" && isManuallyScheduled(post);
}

// ─── Minimal DB interface for testability ─────────────────────────────────────
// Only approvePost takes it: the draft rule above is the part that has to be
// provable without a database. Mirrors publish-post.service.ts — the real Prisma
// client satisfies this narrow shape, and tests inject a fake that captures
// writes.

export interface ApprovalDb {
  post: {
    findUnique: (args: {
      where: { id: string };
      select: {
        companyId: true;
        status: true;
        scheduledFor: true;
        manuallyScheduled: true;
      };
    }) => Promise<{
      companyId: string;
      status: string;
      scheduledFor: Date | null;
      /** True iff a PERSON named this post's publish time. */
      manuallyScheduled: boolean;
    } | null>;
    update: (args: {
      where: { id: string };
      // Unchecked, so approvedById can be written as the plain FK it is.
      data: Prisma.PostUncheckedUpdateInput;
    }) => Promise<unknown>;
  };
  companyMember: {
    findFirst: (args: {
      where: { companyId: string; userId: string };
      select: { role: true };
    }) => Promise<{ role: string } | null>;
  };
}

export interface ApprovalDeps {
  db?: ApprovalDb;
  auditLog?: typeof createAuditLog;
  /** Read once, so the check and the stamped timestamp agree. */
  now?: () => Date;
}

async function resolveContext(
  db: ApprovalDb,
  postId: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<
  | { ok: false; code: "NOT_FOUND" }
  | {
      ok: true;
      postStatus: string;
      isOwner: boolean;
      companyId: string;
      scheduledFor: Date | null;
      manuallyScheduled: boolean;
    }
> {
  // scheduledFor/manuallyScheduled are read for every transition, not just
  // approval, so all three share one query shape. Only `canApprove` reads them.
  const post = await db.post.findUnique({
    where: { id: postId },
    select: {
      companyId: true,
      status: true,
      scheduledFor: true,
      manuallyScheduled: true,
    },
  });
  if (!post) return { ok: false, code: "NOT_FOUND" };

  const base = {
    postStatus: post.status,
    companyId: post.companyId,
    scheduledFor: post.scheduledFor,
    manuallyScheduled: post.manuallyScheduled,
  };

  if (isGlobalAdmin) {
    return { ok: true, ...base, isOwner: true };
  }

  const membership = await db.companyMember.findFirst({
    where: { companyId: post.companyId, userId },
    select: { role: true },
  });
  if (!membership) return { ok: false, code: "NOT_FOUND" };

  return { ok: true, ...base, isOwner: membership.role === "owner" };
}

export async function submitForApproval(
  postId: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<ApprovalResult> {
  const ctx = await resolveContext(prisma, postId, userId, isGlobalAdmin);
  if (!ctx.ok) return { success: false, code: ctx.code };

  if (ctx.postStatus !== "draft") {
    return {
      success: false,
      code: "INVALID_TRANSITION",
      message: `Only draft posts can be submitted for approval. Current status: ${ctx.postStatus.toUpperCase()}.`,
    };
  }

  await prisma.post.update({
    where: { id: postId },
    data: { status: "pending_approval" },
  });

  await createAuditLog({
    companyId: ctx.companyId,
    userId,
    action: AUDIT_ACTIONS.POST_SUBMITTED,
    entityType: "post",
    entityId: postId,
  });

  return { success: true, status: "PENDING_APPROVAL" };
}

/**
 * Approves a post without publishing it.
 *
 * Owner-only. Accepts a submitted post, and a manual bulk draft whose time is
 * still to come — see `canApprove` for why those two and nothing else.
 *
 * Nothing here talks to Buffer, and that is the point for a scheduled post: the
 * post is left `approved` with its `scheduledFor` and `manuallyScheduled` exactly
 * as they were, which is precisely what publishScheduledPosts looks for. It goes
 * out on the first sweep at or after its own time, and not before.
 */
export async function approvePost(
  postId: string,
  userId: string,
  isGlobalAdmin: boolean,
  deps: ApprovalDeps = {}
): Promise<ApprovalResult> {
  const db: ApprovalDb = deps.db ?? prisma;
  const auditLog = deps.auditLog ?? createAuditLog;
  const at = (deps.now ?? (() => new Date()))();

  const ctx = await resolveContext(db, postId, userId, isGlobalAdmin);
  if (!ctx.ok) return { success: false, code: ctx.code };

  if (!ctx.isOwner) return { success: false, code: "FORBIDDEN" };

  if (
    !canApprove({
      status: ctx.postStatus,
      scheduledFor: ctx.scheduledFor,
      manuallyScheduled: ctx.manuallyScheduled,
    })
  ) {
    return {
      success: false,
      code: "INVALID_TRANSITION",
      message:
        `Only posts awaiting approval — or a post scheduled for a later time — can be ` +
        `approved. Current status: ${ctx.postStatus.toUpperCase()}.`,
    };
  }

  // status is the only field this writes besides the approver stamp. scheduledFor
  // and manuallyScheduled are untouched, so the sweep still sees the same post it
  // would have seen: same time, same promise about it.
  await db.post.update({
    where: { id: postId },
    data: { status: "approved", approvedById: userId, approvedAt: at },
  });

  await auditLog({
    companyId: ctx.companyId,
    userId,
    action: AUDIT_ACTIONS.POST_APPROVED,
    entityType: "post",
    entityId: postId,
  });

  return { success: true, status: "APPROVED" };
}

export async function rejectPost(
  postId: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<ApprovalResult> {
  const ctx = await resolveContext(prisma, postId, userId, isGlobalAdmin);
  if (!ctx.ok) return { success: false, code: ctx.code };

  if (!ctx.isOwner) return { success: false, code: "FORBIDDEN" };

  if (ctx.postStatus !== "pending_approval") {
    return {
      success: false,
      code: "INVALID_TRANSITION",
      message: `Only pending approval posts can be rejected. Current status: ${ctx.postStatus.toUpperCase()}.`,
    };
  }

  await prisma.post.update({
    where: { id: postId },
    data: { status: "rejected", rejectedById: userId, rejectedAt: new Date() },
  });

  await createAuditLog({
    companyId: ctx.companyId,
    userId,
    action: AUDIT_ACTIONS.POST_REJECTED,
    entityType: "post",
    entityId: postId,
  });

  return { success: true, status: "REJECTED" };
}
