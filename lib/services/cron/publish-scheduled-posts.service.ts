import { prisma } from "@/lib/db/client";
import { getBufferClient } from "@/lib/buffer/buffer-provider";
import { BufferNoConnectionError, BufferTokenExpiredError } from "@/lib/buffer/buffer-errors";
import {
  MOCK_BUFFER_POST_ID,
  loadBufferProfileMap,
  markPostFailed,
  markPostSent,
  sendPostToBuffer,
} from "./_send-post";

/** Posts due within this window are sent to Buffer (per plan, Phase 8 step 5). */
const PUBLISH_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Bounds Buffer API calls per run to stay inside the function timeout. */
const MAX_PUBLISHES_PER_RUN = 10;

export interface PublishScheduledSummary {
  published: number;
  failed: number;
  skipped: number;
  reason?: "NO_CONNECTION" | "TOKEN_EXPIRED";
  failures: Array<{ postId: string; message: string }>;
}

/**
 * Cron step 5 — sends approved posts whose scheduledFor falls within the next
 * 48 hours to Buffer. Connection-level problems (no connection, expired
 * token) skip the whole step without consuming posts' retry budget; per-post
 * errors mark the post failed for the retry step to pick up.
 */
export async function publishScheduledPosts(companyId: string): Promise<PublishScheduledSummary> {
  const windowEnd = new Date(Date.now() + PUBLISH_WINDOW_MS);

  const posts = await prisma.post.findMany({
    where: {
      companyId,
      status: "approved",
      scheduledFor: { not: null, lte: windowEnd },
    },
    orderBy: { scheduledFor: "asc" },
    take: MAX_PUBLISHES_PER_RUN,
    select: {
      id: true,
      channel: true,
      content: true,
      hashtags: true,
      mediaAsset: { select: { url: true } },
    },
  });

  const summary: PublishScheduledSummary = { published: 0, failed: 0, skipped: 0, failures: [] };
  if (posts.length === 0) return summary;

  // ── Mock mode ──────────────────────────────────────────────────────────────
  if (process.env.AI_MOCK_MODE === "true") {
    for (const post of posts) {
      await markPostSent(companyId, post.id, MOCK_BUFFER_POST_ID, { mock: true });
      summary.published++;
    }
    return summary;
  }

  let client: Awaited<ReturnType<typeof getBufferClient>>;
  try {
    client = await getBufferClient(companyId);
  } catch (err) {
    if (err instanceof BufferNoConnectionError) {
      summary.skipped = posts.length;
      summary.reason = "NO_CONNECTION";
      return summary;
    }
    if (err instanceof BufferTokenExpiredError) {
      summary.skipped = posts.length;
      summary.reason = "TOKEN_EXPIRED";
      return summary;
    }
    throw err;
  }

  const profileMap = await loadBufferProfileMap(companyId);

  for (const post of posts) {
    const profileId = profileMap.get(post.channel);
    if (!profileId) {
      const message = `No Buffer profile configured for channel ${post.channel}. Set one in the channel settings.`;
      await markPostFailed(companyId, post.id, message, { incrementRetry: false });
      summary.failed++;
      summary.failures.push({ postId: post.id, message });
      continue;
    }

    const outcome = await sendPostToBuffer(client, post, profileId);

    if (outcome.ok) {
      await markPostSent(
        companyId,
        post.id,
        outcome.updateId,
        { channel: post.channel },
        outcome.publishedUrl
      );
      summary.published++;
      continue;
    }

    if (outcome.tokenExpired) {
      // Affects every remaining post equally — abort without burning retries.
      summary.skipped += posts.length - summary.published - summary.failed;
      summary.reason = "TOKEN_EXPIRED";
      return summary;
    }

    await markPostFailed(companyId, post.id, outcome.message, { incrementRetry: false });
    summary.failed++;
    summary.failures.push({ postId: post.id, message: outcome.message });
  }

  return summary;
}
