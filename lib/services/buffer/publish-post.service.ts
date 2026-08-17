import { prisma } from "@/lib/db/client";
import type { Prisma, SocialChannel } from "@prisma/client";
import { getBufferClient } from "@/lib/buffer/buffer-provider";
import {
  BufferNoConnectionError,
  BufferApiError,
  BufferTokenExpiredError,
  BufferInvalidProfileError,
} from "@/lib/buffer/buffer-errors";
import { createAuditLog, AUDIT_ACTIONS } from "@/lib/services/audit/audit-log.service";
import { checkBlockingConstraints, type PolicyViolation } from "@/lib/ai/channel-policy";
import { blocksOnDemandPublish } from "@/lib/scheduling/publish-window";
import type { BufferPublishResult } from "@/lib/buffer/buffer-client";

const MOCK_BUFFER_POST_ID = "mock-buffer-post";

/** Shared with the cron publisher so scheduled and manual posts render identically. */
export function buildPostText(content: string, hashtags: string[]): string {
  if (hashtags.length === 0) return content;
  const tags = hashtags.map((t) => `#${t}`).join(" ");
  return `${content}\n\n${tags}`;
}

export interface PublishPostDTO {
  bufferPostId: string;
  status: string;
  publishedAt: string;
  profileId: string;
  publishedPostUrl: string | null;
  /**
   * Whether this call also approved the post (it was still a draft or awaiting
   * approval). False when it was already approved — e.g. by a fully_automated
   * channel — and only the publish was left to do.
   */
  approved: boolean;
}

export type PublishPostResult =
  | { success: true; data: PublishPostDTO }
  | {
      success: false;
      code:
        | "NOT_FOUND"
        | "FORBIDDEN"
        | "INVALID_STATUS"
        /** A person scheduled this post for later; the sweep will send it then. */
        | "NOT_DUE"
        | "NO_CONNECTION"
        | "TOKEN_EXPIRED"
        | "INVALID_PROFILE"
        | "BUFFER_API_ERROR";
      message?: string;
    }
  /** A verified platform constraint (v2-3) rejected the post before Buffer was called. */
  | {
      success: false;
      code: "POLICY_VIOLATION";
      message: string;
      violations: PolicyViolation[];
    };

/**
 * Statuses this action accepts.
 *
 *   • draft / pending_approval — an owner publishing these approves them on the
 *     way out; the two steps are one decision (see lib/posts/post-actions.ts).
 *   • approved — nothing left to approve, including a post a fully_automated
 *     channel approved at generation. Publish only.
 *
 * `rejected` is absent on purpose: an owner turned that post down, so it must be
 * resubmitted rather than published straight from the card.
 */
const PUBLISHABLE_STATUSES: ReadonlySet<string> = new Set([
  "draft",
  "pending_approval",
  "approved",
]);

// ─── Minimal DB interface for testability ─────────────────────────────────────
// Mirrors generate-draft-post.service.ts: the real Prisma client satisfies this
// narrow shape, and unit tests inject a fake that captures writes.

export interface PublishPostDb {
  post: {
    findUnique: (args: {
      where: { id: string };
      select: {
        companyId: true;
        status: true;
        channel: true;
        content: true;
        hashtags: true;
        mediaAssetId: true;
        mediaAsset: { select: { url: true } };
        scheduledFor: true;
        manuallyScheduled: true;
      };
    }) => Promise<{
      companyId: string;
      status: string;
      channel: SocialChannel;
      content: string;
      hashtags: string[];
      mediaAssetId: string | null;
      mediaAsset: { url: string } | null;
      scheduledFor: Date | null;
      /** True iff a PERSON named this post's publish time. */
      manuallyScheduled: boolean;
    } | null>;
    update: (args: {
      where: { id: string };
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

/** The slice of BufferClient this service uses. */
export interface BufferSender {
  publishUpdate: (
    profileIds: string[],
    text: string,
    options?: { mediaUrl?: string }
  ) => Promise<BufferPublishResult>;
}

export interface PublishPostDeps {
  db?: PublishPostDb;
  auditLog?: typeof createAuditLog;
  /** Resolves a Buffer client for the company. Injected in tests. */
  bufferClient?: (companyId: string) => Promise<BufferSender>;
  /** Read once, so the due-check and the stamped timestamps agree. */
  now?: () => Date;
}

/**
 * Approves (when still needed) and publishes a post to Buffer — the owner's
 * single primary action.
 *
 * Owner-only, consistent with connecting/disconnecting Buffer: an editor gets
 * FORBIDDEN here and hands work over with submitForApproval instead. The
 * approval workflow itself is untouched — this only spares an owner from
 * performing an approval, on their own post, that they were always going to
 * grant. approvedById/approvedAt and a POST_APPROVED audit entry are recorded
 * exactly as approvePost would have written them.
 *
 * Ordering is what keeps a Buffer failure clean: every validation runs, then
 * Buffer is called, and only then is anything written. A post that Buffer
 * rejects therefore keeps the status it arrived with — it is never left approved
 * but unpublished, and the owner can simply try again.
 *
 * It will NOT publish a manually scheduled post before its time — that is
 * `blocksOnDemandPublish`, and it returns NOT_DUE. Approving such a post is a
 * separate action (approvePost); the publishing sweep sends it once due.
 */
export async function approveAndPublishPost(
  postId: string,
  profileId: string,
  userId: string,
  isGlobalAdmin: boolean,
  deps: PublishPostDeps = {}
): Promise<PublishPostResult> {
  const db: PublishPostDb = deps.db ?? prisma;
  const auditLog = deps.auditLog ?? createAuditLog;
  const bufferClient = deps.bufferClient ?? getBufferClient;
  const at = (deps.now ?? (() => new Date()))();

  // Load post with company and media
  const post = await db.post.findUnique({
    where: { id: postId },
    select: {
      companyId: true,
      status: true,
      channel: true,
      content: true,
      hashtags: true,
      mediaAssetId: true,
      mediaAsset: { select: { url: true } },
      scheduledFor: true,
      manuallyScheduled: true,
    },
  });

  if (!post) return { success: false, code: "NOT_FOUND" };

  // Verify access — Buffer publish is owner-only, consistent with connect/disconnect
  if (!isGlobalAdmin) {
    const membership = await db.companyMember.findFirst({
      where: { companyId: post.companyId, userId },
      select: { role: true },
    });
    if (!membership) return { success: false, code: "NOT_FOUND" };
    if (membership.role !== "owner") return { success: false, code: "FORBIDDEN" };
  }

  if (!PUBLISHABLE_STATUSES.has(post.status)) {
    return {
      success: false,
      code: "INVALID_STATUS",
      message: `Only draft, pending approval, or approved posts can be published. Current status: ${post.status.toUpperCase()}.`,
    };
  }

  // A person named a later time for this post, so this action must not send it —
  // approving is not the same as publishing early. It is refused outright rather
  // than approved-and-held, so nothing is written on a request that cannot do
  // what it was asked to do; the card offers a plain Approve for these posts
  // (see lib/posts/post-actions.ts) and the sweep sends them once due.
  if (blocksOnDemandPublish(post, at)) {
    return {
      success: false,
      code: "NOT_DUE",
      message:
        `This post is scheduled for ${(post.scheduledFor as Date).toISOString()} and cannot be ` +
        `published before then. Approve it and it will be published automatically at that time.`,
    };
  }

  // Already approved (a prior approval, or a fully_automated channel approving at
  // generation) — publish without re-stamping it or logging a second approval.
  const needsApproval = post.status !== "approved";

  // Verified platform constraints (v2-3) — checked before any publish path,
  // including mock mode, because a violation is a property of the post itself
  // rather than of Buffer.
  const violations = checkBlockingConstraints({
    channel: post.channel,
    mediaAssetId: post.mediaAssetId,
  });
  if (violations.length > 0) {
    return {
      success: false,
      code: "POLICY_VIOLATION",
      message: violations.map((v) => v.description).join(" "),
      violations,
    };
  }

  const text = buildPostText(post.content, post.hashtags);
  const mediaUrl = post.mediaAsset?.url;

  // ── Send to Buffer ─────────────────────────────────────────────────────────
  // Nothing below this point may fail the post: every write happens after Buffer
  // has accepted it.
  let bufferResult: BufferPublishResult;

  if (process.env.AI_MOCK_MODE === "true") {
    bufferResult = { updateId: MOCK_BUFFER_POST_ID, status: "sent", publishedUrl: null };
  } else {
    let client: BufferSender;
    try {
      client = await bufferClient(post.companyId);
    } catch (err) {
      if (err instanceof BufferNoConnectionError) {
        return { success: false, code: "NO_CONNECTION" };
      }
      throw err;
    }

    try {
      bufferResult = await client.publishUpdate([profileId], text, { mediaUrl });
    } catch (err) {
      // Buffer refused the post. No write has happened, so it stays exactly as
      // it was — still a draft or still pending — and remains retryable.
      if (err instanceof BufferTokenExpiredError) {
        return { success: false, code: "TOKEN_EXPIRED", message: err.message };
      }
      if (err instanceof BufferInvalidProfileError) {
        return { success: false, code: "INVALID_PROFILE", message: err.message };
      }
      if (err instanceof BufferApiError) {
        return { success: false, code: "BUFFER_API_ERROR", message: err.message };
      }
      throw err;
    }
  }

  // ── Persist the final state ────────────────────────────────────────────────
  // One update carries both the approval and the publish, so the post can never
  // be observed approved-but-unpublished or published-but-unapproved.
  await db.post.update({
    where: { id: postId },
    data: {
      status: "sent_to_buffer",
      bufferUpdateId: bufferResult.updateId,
      publishedPostUrl: bufferResult.publishedUrl,
      publishedAt: at,
      // manuallyScheduled/scheduledFor are deliberately absent: a hand-scheduled
      // post keeps the time a person gave it for the lifetime of the post.
      ...(needsApproval ? { approvedById: userId, approvedAt: at } : {}),
    },
  });

  // Traceability matches the click-by-click route: the approval this action
  // performed is logged in its own right, so the activity trail reads the same
  // whether an owner used one button or three.
  if (needsApproval) {
    await auditLog({
      companyId: post.companyId,
      userId,
      action: AUDIT_ACTIONS.POST_APPROVED,
      entityType: "post",
      entityId: postId,
      metadata: { viaPublish: true },
    });
  }

  await auditLog({
    companyId: post.companyId,
    userId,
    action: AUDIT_ACTIONS.POST_PUBLISHED,
    entityType: "post",
    entityId: postId,
    metadata: { profileId, bufferUpdateId: bufferResult.updateId },
  });

  return {
    success: true,
    data: {
      bufferPostId: bufferResult.updateId,
      status: "SENT_TO_BUFFER",
      publishedAt: at.toISOString(),
      profileId,
      publishedPostUrl: bufferResult.publishedUrl,
      approved: needsApproval,
    },
  };
}
