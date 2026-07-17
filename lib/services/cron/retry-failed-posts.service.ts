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

const MAX_RETRIES = 3;

/** Backoff between attempts: retryCount × 10 minutes (per plan, Phase 8 step 6). */
const BACKOFF_UNIT_MS = 10 * 60 * 1000;

/** Bounds retry attempts per run. */
const MAX_ATTEMPTS_PER_RUN = 5;

export interface RetryFailedSummary {
  retried: number;
  recovered: number;
  stillFailing: number;
  skipped: number;
  reason?: "NO_CONNECTION" | "TOKEN_EXPIRED";
}

/**
 * Cron step 6 — re-attempts Buffer delivery for failed posts with remaining
 * retry budget (retryCount < 3) once their backoff window has elapsed.
 * Each attempt increments retryCount; posts exhausting the budget stay
 * failed and surface to the owner via lastError in the UI.
 */
export async function retryFailedPosts(companyId: string): Promise<RetryFailedSummary> {
  const now = Date.now();

  const candidates = await prisma.post.findMany({
    where: {
      companyId,
      status: "failed",
      retryCount: { lt: MAX_RETRIES },
    },
    orderBy: { updatedAt: "asc" },
    take: MAX_ATTEMPTS_PER_RUN * 2, // headroom for backoff filtering below
    select: {
      id: true,
      channel: true,
      content: true,
      hashtags: true,
      retryCount: true,
      updatedAt: true,
      mediaAssetId: true,
      mediaAsset: { select: { url: true } },
    },
  });

  const due = candidates
    .filter((p) => p.updatedAt.getTime() + p.retryCount * BACKOFF_UNIT_MS <= now)
    .slice(0, MAX_ATTEMPTS_PER_RUN);

  const summary: RetryFailedSummary = { retried: 0, recovered: 0, stillFailing: 0, skipped: 0 };
  if (due.length === 0) return summary;

  // ── Mock mode ──────────────────────────────────────────────────────────────
  if (process.env.AI_MOCK_MODE === "true") {
    for (const post of due) {
      await markPostSent(companyId, post.id, MOCK_BUFFER_POST_ID, { mock: true, retry: true });
      summary.retried++;
      summary.recovered++;
    }
    return summary;
  }

  let client: Awaited<ReturnType<typeof getBufferClient>>;
  try {
    client = await getBufferClient(companyId);
  } catch (err) {
    if (err instanceof BufferNoConnectionError) {
      summary.skipped = due.length;
      summary.reason = "NO_CONNECTION";
      return summary;
    }
    if (err instanceof BufferTokenExpiredError) {
      summary.skipped = due.length;
      summary.reason = "TOKEN_EXPIRED";
      return summary;
    }
    throw err;
  }

  const profileMap = await loadBufferProfileMap(companyId);

  for (const post of due) {
    const profileId = profileMap.get(post.channel);
    if (!profileId) {
      summary.retried++;
      summary.stillFailing++;
      await markPostFailed(
        companyId,
        post.id,
        `No Buffer profile configured for channel ${post.channel}. Set one in the channel settings.`,
        { incrementRetry: true }
      );
      continue;
    }

    const outcome = await sendPostToBuffer(client, post, profileId);
    summary.retried++;

    if (outcome.ok) {
      await markPostSent(
        companyId,
        post.id,
        outcome.updateId,
        {
          channel: post.channel,
          retry: true,
          attempt: post.retryCount + 1,
        },
        outcome.publishedUrl
      );
      summary.recovered++;
      continue;
    }

    if (outcome.tokenExpired) {
      summary.retried--;
      summary.skipped = due.length - summary.retried;
      summary.reason = "TOKEN_EXPIRED";
      return summary;
    }

    await markPostFailed(companyId, post.id, outcome.message, { incrementRetry: true });
    summary.stillFailing++;
  }

  return summary;
}
