import { prisma } from "@/lib/db/client";

/**
 * Read side for post metrics — shaped for the generated post card.
 *
 * `state` is what the card switches on. It is deliberately explicit rather than
 * "metrics or null", because the four non-success cases mean genuinely different
 * things to an owner and each needs its own message:
 *
 *   disabled   — no Personal API Key. Analytics are off. Not an error.
 *   pending    — key present, but this post has not been synced yet.
 *   no_data    — Buffer has the post and reported nothing for it.
 *   forbidden  — the key belongs to a different Buffer account than this post.
 *   ready      — real metrics.
 */

export type PostMetricsState = "disabled" | "pending" | "no_data" | "forbidden" | "ready";

export interface PostMetricsView {
  state: PostMetricsState;
  channelService: string | null;
  reactions: number | null;
  comments: number | null;
  shares: number | null;
  impressions: number | null;
  clicks: number | null;
  reach: number | null;
  views: number | null;
  saves: number | null;
  follows: number | null;
  engagementRate: number | null;
  engagementRateDenominator: string | null;
  /** When WE read them. Drives the "updated X ago" hint. */
  collectedAt: string | null;
  /** When BUFFER last refreshed from the network — up to ~24h behind reality. */
  metricsUpdatedAt: string | null;
}

const EMPTY = {
  channelService: null,
  reactions: null,
  comments: null,
  shares: null,
  impressions: null,
  clicks: null,
  reach: null,
  views: null,
  saves: null,
  follows: null,
  engagementRate: null,
  engagementRateDenominator: null,
  collectedAt: null,
  metricsUpdatedAt: null,
} as const;

export function disabledMetrics(): PostMetricsView {
  return { state: "disabled", ...EMPTY };
}

/**
 * Batch-loads metrics for a set of posts, keyed by post id.
 *
 * Batched because the company page renders many cards at once; one query for the
 * page beats one per card. Posts with no row map to `pending`, so a caller can
 * rely on every requested id being present in the result.
 */
export async function getPostMetricsForPosts(
  companyId: string,
  postIds: string[],
  analyticsEnabled: boolean
): Promise<Map<string, PostMetricsView>> {
  const out = new Map<string, PostMetricsView>();

  if (!analyticsEnabled) {
    for (const id of postIds) out.set(id, disabledMetrics());
    return out;
  }
  if (postIds.length === 0) return out;

  const rows = await prisma.postMetric.findMany({
    where: { companyId, postId: { in: postIds } },
  });

  const byPost = new Map(rows.map((r) => [r.postId, r]));

  for (const id of postIds) {
    const row = byPost.get(id);

    // No row yet: the key is configured but the cron has not reached this post.
    if (!row) {
      out.set(id, { state: "pending", ...EMPTY });
      continue;
    }

    // An errored read is shown as pending on purpose: it is transient and will be
    // retried next run, so telling an owner "analytics failed" would be noise.
    const state: PostMetricsState =
      row.syncStatus === "ok"
        ? "ready"
        : row.syncStatus === "no_data"
          ? "no_data"
          : row.syncStatus === "forbidden"
            ? "forbidden"
            : "pending";

    out.set(id, {
      state,
      channelService: row.channelService,
      reactions: row.reactions,
      comments: row.comments,
      shares: row.shares,
      impressions: row.impressions,
      clicks: row.clicks,
      reach: row.reach,
      views: row.views,
      saves: row.saves,
      follows: row.follows,
      engagementRate: row.engagementRate,
      engagementRateDenominator: row.engagementRateDenominator,
      collectedAt: row.collectedAt.toISOString(),
      metricsUpdatedAt: row.metricsUpdatedAt?.toISOString() ?? null,
    });
  }

  return out;
}
