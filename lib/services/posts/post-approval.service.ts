import { prisma } from "@/lib/db/client";
import type { Prisma } from "@prisma/client";
import { createAuditLog, AUDIT_ACTIONS } from "@/lib/services/audit/audit-log.service";
import { missedItsSchedule } from "@/lib/scheduling/publish-window";

export type ApprovalError = "NOT_FOUND" | "FORBIDDEN" | "INVALID_TRANSITION";

export type ApprovalResult =
  { success: true; status: string } | { success: false; code: ApprovalError; message?: string };

/**
 * Approving can fail one way `rejectPost` cannot: the post's own hand-chosen
 * publish time went by before anybody approved it. Declared only here, so
 * `rejectPost` — which has no schedule to miss — keeps exhaustive error
 * handling in its own route.
 */
export type ApprovePostError = ApprovalError | "SCHEDULE_MISSED";

export type ApprovePostResult =
  { success: true; status: string } | { success: false; code: ApprovePostError; message?: string };

/** Why an approval was refused, or null when it may go ahead. */
export type ApprovalRefusal = "INVALID_TRANSITION" | "SCHEDULE_MISSED";

/**
 * Which posts `approvePost` will move to `approved`.
 *
 *   • `draft` — the ordinary case, from either an editor or an owner. There
 *     used to be a mandatory hand-off first ("Submit for approval", moving the
 *     post to `pending_approval`, only an owner could approve past it). That
 *     step is gone: approving a draft directly, with no submission in between,
 *     is now the whole workflow. Whether the post also carries a hand-chosen
 *     publish time (`manuallyScheduled`) makes no difference to whether it MAY
 *     be approved — only to what happens after, which `decidePublish` and
 *     `blocksOnDemandPublish` already handle unchanged: a scheduled one waits
 *     for its own time via the sweep, an unscheduled one is immediately
 *     publishable by an owner.
 *
 *   • `pending_approval` — kept ONLY for backward compatibility. A row created
 *     before this change, or one an editor previously submitted under the old
 *     workflow, still needs a way to reach `approved`. No code path anywhere
 *     creates a new one (see lib/posts/post-status-filter.ts).
 *
 * ── The second question: is the post's own time still ahead? ─────────────────
 *
 * A hand-chosen time that has gone by cannot be honoured, and approving anyway
 * would commit the post to a publish at some moment nobody named. So such a post
 * is refused with SCHEDULE_MISSED until it is given a new time — see
 * `missedItsSchedule`, which is also what the card reads to swap Approve for
 * Reschedule. Status is decided first, because "this post cannot be approved at
 * all" is a better answer than "pick a new time" for one that is already sent.
 *
 * Returns the refusal rather than a boolean: the two are different answers to the
 * user, and only the caller can turn them into responses.
 */
export function canApprove(
  post: {
    status: string;
    scheduledFor: Date | null;
    manuallyScheduled: boolean;
  },
  now: Date
): ApprovalRefusal | null {
  const statusAllows = post.status === "draft" || post.status === "pending_approval";
  if (!statusAllows) return "INVALID_TRANSITION";

  if (missedItsSchedule(post, now)) return "SCHEDULE_MISSED";

  return null;
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
        generatedById: true;
      };
    }) => Promise<{
      companyId: string;
      status: string;
      scheduledFor: Date | null;
      /** True iff a PERSON named this post's publish time. */
      manuallyScheduled: boolean;
      /** Null for a cron/system post — see rejectPost's eligibility check. */
      generatedById: string | null;
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
      generatedById: string | null;
    }
> {
  // scheduledFor/manuallyScheduled/generatedById are read for every
  // transition, not just approval, so all four share one query shape. Only
  // `canApprove` reads the schedule pair; only `rejectPost` reads `generatedById`.
  const post = await db.post.findUnique({
    where: { id: postId },
    select: {
      companyId: true,
      status: true,
      scheduledFor: true,
      manuallyScheduled: true,
      generatedById: true,
    },
  });
  if (!post) return { ok: false, code: "NOT_FOUND" };

  const base = {
    postStatus: post.status,
    companyId: post.companyId,
    scheduledFor: post.scheduledFor,
    manuallyScheduled: post.manuallyScheduled,
    generatedById: post.generatedById,
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

/**
 * Approves a post without publishing it.
 *
 * ANY company member — editor or owner — may call this. Editors can review and
 * approve their own or another editor's draft, but structurally cannot publish
 * it: `approveAndPublishPost` (lib/services/buffer/publish-post.service.ts) is
 * the ONLY route to Buffer, and it enforces owner-only on its own, independent
 * of anything decided here. There used to be a "Submit for approval" step
 * between draft and this action — an editor handed a draft to an owner, who
 * alone could then approve it. That step is gone: no code path creates a new
 * `draft` → `pending_approval` transition any more (see
 * lib/posts/post-status-filter.ts for what `pending_approval` still means for
 * PRE-EXISTING rows). Approving is now the direct, one-step action every
 * draft gets, from either role.
 *
 * `pending_approval` remains an ACCEPTED status here purely for backward
 * compatibility — a row created before this change, or one an editor
 * previously submitted, still needs a way to reach `approved`. No code path
 * anywhere creates a new one.
 *
 * See `canApprove` for the full status/schedule rule, and why a post whose
 * hand-chosen time has already gone by is refused until it is rescheduled.
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
): Promise<ApprovePostResult> {
  const db: ApprovalDb = deps.db ?? prisma;
  const auditLog = deps.auditLog ?? createAuditLog;
  const at = (deps.now ?? (() => new Date()))();

  const ctx = await resolveContext(db, postId, userId, isGlobalAdmin);
  if (!ctx.ok) return { success: false, code: ctx.code };

  // No role check: `resolveContext` already required company membership (a
  // non-member gets NOT_FOUND above), and approving no longer distinguishes
  // editor from owner. Publishing is the action that still does — enforced
  // independently in approveAndPublishPost.
  const refusal = canApprove(
    {
      status: ctx.postStatus,
      scheduledFor: ctx.scheduledFor,
      manuallyScheduled: ctx.manuallyScheduled,
    },
    at
  );

  if (refusal === "INVALID_TRANSITION") {
    return {
      success: false,
      code: "INVALID_TRANSITION",
      message:
        `Only posts awaiting approval — or a post scheduled for a later time — can be ` +
        `approved. Current status: ${ctx.postStatus.toUpperCase()}.`,
    };
  }

  if (refusal === "SCHEDULE_MISSED") {
    return {
      success: false,
      code: "SCHEDULE_MISSED",
      message:
        `This post was scheduled for ${(ctx.scheduledFor as Date).toISOString()} and that time ` +
        `has passed. Choose a new publish time before approving it.`,
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
  isGlobalAdmin: boolean,
  deps: ApprovalDeps = {}
): Promise<ApprovalResult> {
  const db: ApprovalDb = deps.db ?? prisma;
  const auditLog = deps.auditLog ?? createAuditLog;

  const ctx = await resolveContext(db, postId, userId, isGlobalAdmin);
  if (!ctx.ok) return { success: false, code: ctx.code };

  if (!ctx.isOwner) return { success: false, code: "FORBIDDEN" };

  // `pending_approval` — the workflow's own step (an editor's submission, or a
  // legacy row). `draft`, but ONLY with no human author — a cron-generated post,
  // which now lands in `draft` exactly like a manual one. `generatedById` is
  // the only thing left to tell the two apart, since both share the same
  // status: a human's own unfinished draft is NEVER rejectable — there is
  // nothing to reject about work nobody submitted, and deleting it is that
  // person's own call. See lib/posts/post-actions.ts for the mirrored client
  // check that decides whether the card even offers this.
  const rejectable =
    ctx.postStatus === "pending_approval" ||
    (ctx.postStatus === "draft" && ctx.generatedById === null);

  if (!rejectable) {
    return {
      success: false,
      code: "INVALID_TRANSITION",
      message: `Only a pending-approval post, or a system-generated draft, can be rejected. Current status: ${ctx.postStatus.toUpperCase()}.`,
    };
  }

  await db.post.update({
    where: { id: postId },
    data: { status: "rejected", rejectedById: userId, rejectedAt: new Date() },
  });

  await auditLog({
    companyId: ctx.companyId,
    userId,
    action: AUDIT_ACTIONS.POST_REJECTED,
    entityType: "post",
    entityId: postId,
  });

  return { success: true, status: "REJECTED" };
}
