import { prisma } from "@/lib/db/client";
import type { BufferClient } from "@/lib/buffer/buffer-client";
import { BufferTokenExpiredError } from "@/lib/buffer/buffer-errors";
import { buildPostText } from "@/lib/services/buffer/publish-post.service";
import { createAuditLog, AUDIT_ACTIONS } from "@/lib/services/audit/audit-log.service";

export const MOCK_BUFFER_POST_ID = "mock-buffer-post";

/** The post fields the cron sender needs. */
export interface SendablePost {
  id: string;
  channel: string;
  content: string;
  hashtags: string[];
  mediaAsset: { url: string } | null;
}

export type SendOutcome =
  { ok: true; updateId: string } | { ok: false; message: string; tokenExpired: boolean };

export async function sendPostToBuffer(
  client: BufferClient,
  post: SendablePost,
  profileId: string
): Promise<SendOutcome> {
  try {
    const result = await client.publishUpdate(
      [profileId],
      buildPostText(post.content, post.hashtags),
      { mediaUrl: post.mediaAsset?.url }
    );
    return { ok: true, updateId: result.updateId };
  } catch (err) {
    if (err instanceof BufferTokenExpiredError) {
      return { ok: false, message: err.message, tokenExpired: true };
    }
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Unknown Buffer error.",
      tokenExpired: false,
    };
  }
}

/** Channel → Buffer profile mapping from the company's channel configs. */
export async function loadBufferProfileMap(companyId: string): Promise<Map<string, string>> {
  const configs = await prisma.channelConfig.findMany({
    where: { companyId, isActive: true, bufferProfileId: { not: null } },
    select: { channel: true, bufferProfileId: true },
  });
  return new Map(configs.map((c) => [c.channel as string, c.bufferProfileId as string]));
}

export async function markPostSent(
  companyId: string,
  postId: string,
  bufferUpdateId: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await prisma.post.update({
    where: { id: postId },
    data: { status: "sent_to_buffer", bufferUpdateId, publishedAt: new Date(), lastError: null },
  });
  await createAuditLog({
    companyId,
    action: AUDIT_ACTIONS.POST_PUBLISHED,
    entityType: "post",
    entityId: postId,
    metadata: { automated: true, bufferUpdateId, ...metadata },
  });
}

export async function markPostFailed(
  companyId: string,
  postId: string,
  message: string,
  options: { incrementRetry: boolean }
): Promise<void> {
  await prisma.post.update({
    where: { id: postId },
    data: {
      status: "failed",
      lastError: message,
      ...(options.incrementRetry ? { retryCount: { increment: 1 } } : {}),
    },
  });
  await createAuditLog({
    companyId,
    action: AUDIT_ACTIONS.POST_PUBLISH_FAILED,
    entityType: "post",
    entityId: postId,
    metadata: { automated: true, error: message },
  });
}
