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

/** The row fields the state decision looks at. */
interface StateInput {
  syncStatus: string;
  /** True when the row still holds figures from an earlier successful read. */
  hasFigures: boolean;
}

/**
 * Decides what a row means to the card.
 *
 * Stored figures win over the latest attempt's status. A failed refresh leaves
 * the previous numbers in place (see sync-post-metrics.service), and they are
 * still the truth as of the last successful read — hiding them behind "waiting
 * for the first sync" would turn one transient Buffer error into a post that
 * looks like it never had any engagement, with no manual refresh to recover it.
 *
 * An errored read with nothing stored is shown as pending on purpose: it is
 * transient and retried by the next daily run, so "analytics failed" would be
 * noise to an owner who can do nothing about it.
 */
export function metricsStateFor({ syncStatus, hasFigures }: StateInput): PostMetricsState {
  if (syncStatus === "ok" || hasFigures) return "ready";
  if (syncStatus === "no_data") return "no_data";
  if (syncStatus === "forbidden") return "forbidden";
  return "pending";
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

    // Figures left over from an earlier successful read still count as ready —
    // a failed refresh preserves them rather than clearing the row.
    const hasFigures =
      row.reactions !== null ||
      row.comments !== null ||
      row.shares !== null ||
      row.impressions !== null ||
      row.clicks !== null ||
      row.reach !== null ||
      row.views !== null ||
      row.saves !== null ||
      row.follows !== null ||
      row.engagementRate !== null;

    out.set(id, {
      state: metricsStateFor({ syncStatus: row.syncStatus, hasFigures }),
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
