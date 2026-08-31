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
import { checkProfileChannel } from "@/lib/buffer/profile-channel";
import { MOCK_BUFFER_PROFILES } from "@/lib/buffer/mock-profiles";
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
        /** The chosen Buffer profile is on a different social network than the post. */
        | "CHANNEL_MISMATCH"
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
 * `rejected` is absent on purpose: an owner turned that post down, and that
 * verdict is final — a rejected post has no route back to `approved` at all
 * (edits are permitted, per lib/services/posts/post-editor.service.ts, but
 * never change its status). It is not a click away from Buffer; deleting it
 * is the only next step (lib/services/company/delete-post.service.ts).
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

/** A Buffer profile, as much of it as the channel guard needs. */
export interface TargetProfile {
  id: string;
  name: string;
  /** Buffer's own service string — "facebook", "instagram-business", … */
  service: string;
}

/** The slice of BufferClient this service uses. */
export interface BufferSender {
  /** Read before publishing, to confirm the target profile's social network. */
  getProfiles: () => Promise<TargetProfile[]>;
  publishUpdate: (
    profileIds: string[],
    text: string,
    options?: { mediaUrl?: string }
  ) => Promise<BufferPublishResult>;
}

/** Buffer's own failures, as this service's result codes. Rethrows anything else. */
function bufferFailure(err: unknown): PublishPostResult {
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

/**
 * Refuses a Buffer profile that is not on the post's own social network, as this
 * service's result type.
 *
 * The judgement itself lives in `lib/buffer/profile-channel.ts` and is shared
 * with the cron sender, so a pairing the sweep would refuse is refused here too.
 * It is also the same question `listBufferProfiles` answers for the selector,
 * through the same map, so the server never refuses a profile the picker was
 * willing to offer.
 *
 * Returns the failure to hand back, or null when the pairing is sound.
 */
function profileChannelFailure(
  profiles: readonly TargetProfile[],
  profileId: string,
  channel: SocialChannel
): PublishPostResult | null {
  const check = checkProfileChannel(profiles, profileId, channel);
  if (check.ok) return null;

  return {
    success: false,
    code: check.code === "UNKNOWN_PROFILE" ? "INVALID_PROFILE" : "CHANNEL_MISMATCH",
    message: check.message,
  };
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
 * FORBIDDEN here — enforced independently of anything post-approval.service.ts
 * decides, since that service now lets an editor approve a draft directly.
 * Approving and publishing remain two different rights: every role that can
 * reach `approved` can do so through `approvePost`, but only an owner/admin
 * can reach `sent_to_buffer` through this action. approvedById/approvedAt and
 * a POST_APPROVED audit entry are recorded exactly as approvePost would have
 * written them, for a draft or pending_approval post this call approves on
 * its way out.
 *
 * Ordering is what keeps a Buffer failure clean: every validation runs, then
 * Buffer is called, and only then is anything written. A post that Buffer
 * rejects therefore keeps the status it arrived with — it is never left approved
 * but unpublished, and the owner can simply try again.
 *
 * It will NOT publish a manually scheduled post at all — that is
 * `blocksOnDemandPublish`, and it returns NOT_DUE whatever the clock says. A time
 * a person chose is the sweep's to honour, so approving such a post is a separate
 * action (approvePost) and the sweep is the only thing that delivers it.
 *
 * Nor will it publish to a profile on another social network — that is
 * `checkProfileChannel`, and it returns CHANNEL_MISMATCH. The caller supplies
 * `profileId`, so this is enforced here and not left to the selector.
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

  // A person named this post's time, so delivery belongs to the sweep and not to
  // this action — at any clock reading, including after the time has passed.
  // Refused outright rather than approved-and-held, so nothing is written on a
  // request that cannot do what it was asked to do; the card offers a plain
  // Approve for these posts (see lib/posts/post-actions.ts).
  if (blocksOnDemandPublish(post)) {
    return {
      success: false,
      code: "NOT_DUE",
      message:
        `This post is scheduled for ${(post.scheduledFor as Date).toISOString()} and is sent by ` +
        `the scheduled publishing run rather than on demand. Approve it and that run will ` +
        `publish it; if its time has already gone by, pick a new one.`,
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
    // Mock mode has no Buffer to ask, so the guard runs against the same fixed
    // profiles the selector shows — the pairing is checked here too rather than
    // only on the live path.
    const mismatch = profileChannelFailure(MOCK_BUFFER_PROFILES, profileId, post.channel);
    if (mismatch) return mismatch;

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

    // The target profile must be on this post's own network. Asked before
    // publishing, so a mismatched request costs nothing and writes nothing.
    let profiles: TargetProfile[];
    try {
      profiles = await client.getProfiles();
    } catch (err) {
      return bufferFailure(err);
    }

    const mismatch = profileChannelFailure(profiles, profileId, post.channel);
    if (mismatch) return mismatch;

    try {
      bufferResult = await client.publishUpdate([profileId], text, { mediaUrl });
    } catch (err) {
      // Buffer refused the post. No write has happened, so it stays exactly as
      // it was — still a draft or still pending — and remains retryable.
      return bufferFailure(err);
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
      // manuallyScheduled/scheduledFor are deliberately absent: publishing
      // records delivery and never rewrites when a post was due or whose time
      // that was. (A hand-scheduled post cannot reach this write at all — see
      // blocksOnDemandPublish above — so this now guards the automatic ones.)
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
