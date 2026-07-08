import { prisma } from "@/lib/db/client";
import { getBufferClient } from "@/lib/buffer/buffer-provider";
import {
  BufferNoConnectionError,
  BufferApiError,
  BufferTokenExpiredError,
  BufferInvalidProfileError,
} from "@/lib/buffer/buffer-errors";
import { createAuditLog, AUDIT_ACTIONS } from "@/lib/services/audit/audit-log.service";

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
}

export type PublishPostResult =
  | { success: true; data: PublishPostDTO }
  | {
      success: false;
      code:
        | "NOT_FOUND"
        | "FORBIDDEN"
        | "INVALID_STATUS"
        | "NO_CONNECTION"
        | "TOKEN_EXPIRED"
        | "INVALID_PROFILE"
        | "BUFFER_API_ERROR";
      message?: string;
    };

export async function publishPost(
  postId: string,
  profileId: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<PublishPostResult> {
  // Load post with company and media
  const post = await prisma.post.findUnique({
    where: { id: postId },
    select: {
      companyId: true,
      status: true,
      content: true,
      hashtags: true,
      mediaAsset: { select: { url: true } },
    },
  });

  if (!post) return { success: false, code: "NOT_FOUND" };

  // Verify access — Buffer publish is owner-only, consistent with connect/disconnect
  if (!isGlobalAdmin) {
    const membership = await prisma.companyMember.findFirst({
      where: { companyId: post.companyId, userId },
      select: { role: true },
    });
    if (!membership) return { success: false, code: "NOT_FOUND" };
    if (membership.role !== "owner") return { success: false, code: "FORBIDDEN" };
  }

  if (post.status !== "draft" && post.status !== "approved") {
    return {
      success: false,
      code: "INVALID_STATUS",
      message: `Only draft or approved posts can be published. Current status: ${post.status.toUpperCase()}.`,
    };
  }

  const text = buildPostText(post.content, post.hashtags);
  const mediaUrl = post.mediaAsset?.url;
  const now = new Date().toISOString();

  // ── Mock mode ──────────────────────────────────────────────────────────────
  if (process.env.AI_MOCK_MODE === "true") {
    await prisma.post.update({
      where: { id: postId },
      data: {
        status: "sent_to_buffer",
        bufferUpdateId: MOCK_BUFFER_POST_ID,
        publishedAt: new Date(),
      },
    });

    await createAuditLog({
      companyId: post.companyId,
      userId,
      action: AUDIT_ACTIONS.POST_PUBLISHED,
      entityType: "post",
      entityId: postId,
      metadata: { profileId, bufferUpdateId: MOCK_BUFFER_POST_ID },
    });

    return {
      success: true,
      data: {
        bufferPostId: MOCK_BUFFER_POST_ID,
        status: "SENT_TO_BUFFER",
        publishedAt: now,
        profileId,
        publishedPostUrl: null,
      },
    };
  }

  // ── Real publish ───────────────────────────────────────────────────────────
  let client: Awaited<ReturnType<typeof getBufferClient>>;
  try {
    client = await getBufferClient(post.companyId);
  } catch (err) {
    if (err instanceof BufferNoConnectionError) {
      return { success: false, code: "NO_CONNECTION" };
    }
    throw err;
  }

  let bufferResult: Awaited<ReturnType<typeof client.publishUpdate>>;
  try {
    bufferResult = await client.publishUpdate([profileId], text, { mediaUrl });
  } catch (err) {
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

  await prisma.post.update({
    where: { id: postId },
    data: {
      status: "sent_to_buffer",
      bufferUpdateId: bufferResult.updateId,
      publishedPostUrl: bufferResult.publishedUrl,
      publishedAt: new Date(),
    },
  });

  await createAuditLog({
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
      publishedAt: now,
      profileId,
      publishedPostUrl: bufferResult.publishedUrl,
    },
  };
}
