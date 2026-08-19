import type { SocialChannel } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { BufferClient } from "@/lib/buffer/buffer-client";
import { BufferTokenExpiredError } from "@/lib/buffer/buffer-errors";
import { buildPostText } from "@/lib/services/buffer/publish-post.service";
import { createAuditLog, AUDIT_ACTIONS } from "@/lib/services/audit/audit-log.service";
import { checkBlockingConstraints } from "@/lib/ai/channel-policy";
import {
  bufferServiceToChannel,
  checkProfileChannel,
  type ProfileChannelCandidate,
} from "@/lib/buffer/profile-channel";

export const MOCK_BUFFER_POST_ID = "mock-buffer-post";

/** The post fields the cron sender needs. */
export interface SendablePost {
  id: string;
  channel: SocialChannel;
  content: string;
  hashtags: string[];
  /** Required by the v2-3 policy check; `mediaAsset` alone cannot express it. */
  mediaAssetId: string | null;
  mediaAsset: { url: string } | null;
}

export type SendOutcome =
  | { ok: true; updateId: string; publishedUrl: string | null }
  | { ok: false; message: string; tokenExpired: boolean };

export async function sendPostToBuffer(
  client: BufferClient,
  post: SendablePost,
  profileId: string,
  profiles: readonly ProfileChannelCandidate[]
): Promise<SendOutcome> {
  // Verified platform constraints (v2-3). This is the single choke point every
  // cron publish path funnels through, so the check belongs here rather than in
  // each caller. A violation is permanent — retrying cannot fix a missing
  // image — but it still flows through the normal failure path so the owner
  // sees the reason in lastError.
  const violations = checkBlockingConstraints(post);
  if (violations.length > 0) {
    return {
      ok: false,
      message: violations.map((v) => v.description).join(" "),
      tokenExpired: false,
    };
  }

  // The target profile must be on this post's own network, judged by the SERVICE
  // Buffer reports for it. `loadPublishTargets` already refuses to map a channel
  // to a profile on another network, so reaching this is a caller that built its
  // own pairing — and publishing to the wrong network cannot be undone, so the
  // choke point checks it anyway rather than trusting the map it was handed.
  // Same rule, same wording and same helper as the manual publish action.
  const match = checkProfileChannel(profiles, profileId, post.channel);
  if (!match.ok) {
    return { ok: false, message: match.message, tokenExpired: false };
  }

  try {
    const result = await client.publishUpdate(
      [profileId],
      buildPostText(post.content, post.hashtags),
      { mediaUrl: post.mediaAsset?.url }
    );
    return { ok: true, updateId: result.updateId, publishedUrl: result.publishedUrl };
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

/** Everything a sweep needs to address this company's posts to Buffer. */
export interface PublishTargets {
  /** Buffer's live profiles, as the channel guard needs them. */
  profiles: ProfileChannelCandidate[];
  /** Channel → the Buffer profile that will carry its posts. */
  profileMap: Map<string, string>;
}

/**
 * Resolves, once per sweep, which Buffer profile each channel's posts go to.
 *
 * The pairing is confirmed against Buffer, not merely read out of our own
 * `ChannelConfig.channel`. That column is a copy of what profile sync last saw,
 * and a copy can be stale — a profile reconnected as a different account type,
 * a row written before the service map knew that account type, a hand-edited
 * config. Trusting it is how an INSTAGRAM post gets addressed to a Facebook
 * page, which is exactly what the Analytics work found in live data.
 *
 * A config whose profile Buffer no longer lists, or whose channel disagrees with
 * that profile's service, produces NO mapping. The caller then fails the post
 * with "No Buffer profile configured for channel X" — visible, retryable, and
 * fixed by re-syncing profiles. Publishing it to the wrong network would not be
 * any of those things.
 *
 * A company may hold several profiles on one network (two Facebook pages), and
 * a post names only its channel. The first config wins, ordered exactly as
 * `listChannelConfigs` orders them, so the sweep sends to the same page the
 * generation form's `resolveGenerationChannels` took its settings from.
 */
export async function loadPublishTargets(
  companyId: string,
  client: Pick<BufferClient, "getProfiles">
): Promise<PublishTargets> {
  const [configs, profiles] = await Promise.all([
    prisma.channelConfig.findMany({
      where: { companyId, isActive: true, bufferProfileId: { not: null } },
      select: { channel: true, bufferProfileId: true },
      orderBy: [{ channel: "asc" }, { bufferProfileName: "asc" }],
    }),
    client.getProfiles(),
  ]);

  const byId = new Map(profiles.map((p) => [p.id, p]));
  const profileMap = new Map<string, string>();

  for (const config of configs) {
    const channel = config.channel as string;
    if (profileMap.has(channel)) continue;

    const profile = byId.get(config.bufferProfileId as string);
    if (!profile) continue;
    if (bufferServiceToChannel(profile.service) !== channel) continue;

    profileMap.set(channel, profile.id);
  }

  return { profiles, profileMap };
}

export async function markPostSent(
  companyId: string,
  postId: string,
  bufferUpdateId: string,
  metadata: Record<string, unknown>,
  publishedPostUrl?: string | null
): Promise<void> {
  await prisma.post.update({
    where: { id: postId },
    data: {
      status: "sent_to_buffer",
      bufferUpdateId,
      publishedPostUrl: publishedPostUrl ?? null,
      publishedAt: new Date(),
      lastError: null,
    },
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
