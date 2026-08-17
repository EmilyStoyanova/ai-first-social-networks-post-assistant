import { prisma } from "@/lib/db/client";
import { resolvePostOrigin } from "@/lib/posts/post-origin";
import {
  eligiblePerformanceChannels,
  normalizeChannel,
  resolvePerformanceChannel,
} from "@/lib/analytics/performance-channels";
import type { PostItem } from "./list-posts.service";

/**
 * Everything the Overview page shows, assembled in one place.
 *
 * The page is a health check and a router into work (§4.4), so it reads a
 * little from several domains rather than a lot from one. Gathering that here
 * keeps the page component declarative and keeps the counting rules — which
 * statuses are "published", what "this month" means — in one testable file
 * instead of scattered across JSX.
 *
 * Nothing here is a new capability: every figure is a count over rows the app
 * already writes, and the metric rollup is bounded to a single channel for the
 * reason given on ChannelPerformance below.
 */

export interface OverviewKpis {
  postsThisMonth: number;
  postsThisMonthDelta: number | null;
  pendingApproval: number;
  published: number;
  publishedDelta: number | null;
  connectedChannels: number;
  totalChannels: number;
  rssSources: number;
  rssSourcesWithNewContent: number;
}

/**
 * A single channel's totals.
 *
 * **Single channel by construction, and that is the point.** Buffer's
 * `engagementRate` uses a different denominator per network (impressions on
 * Facebook, reach on Instagram — recorded in `engagementRateDenominator`), and
 * the raw fields are sparse by network too: impressions/clicks are Facebook
 * only in observed data, reach/views/saves/follows Instagram only. Summing
 * across channels would add quantities that measure different things and
 * present the total as if it measured one. So this type holds one channel, and
 * the UI never offers an "all channels" option (§2.6).
 *
 * Within one channel, summing a raw count is legitimate — same network, same
 * definition. `engagementRate` is deliberately absent: it is a ratio Buffer
 * computes per post, and averaging ratios across posts is not the company's
 * engagement rate. Per-post rates stay on the post cards where they belong.
 */
export interface ChannelPerformance {
  channel: string;
  postCount: number;
  /** Null where this network does not report the field at all. */
  impressions: number | null;
  reach: number | null;
  reactions: number | null;
  comments: number | null;
  shares: number | null;
  clicks: number | null;
}

export interface OverviewData {
  kpis: OverviewKpis;
  upcoming: PostItem[];
  performance: ChannelPerformance | null;
  /**
   * Channels the per-channel switch may offer: Buffer-connected *and* having
   * published at least once. See lib/analytics/performance-channels.ts for why
   * the list is not derived from the metrics table.
   */
  availableChannels: string[];
  /**
   * Whether any metrics exist at all. Separate from `availableChannels`, which
   * can be non-empty before the first sync has run — a caller inferring "the
   * analytics key works" from the channel list would otherwise be wrong for the
   * whole first day.
   */
  hasMetrics: boolean;
  /** Unread, still-enabled feed items per source id. Absent means zero. */
  newItemsBySource: Record<string, number>;
}

const PUBLISHED_STATUSES = ["sent_to_buffer", "published"] as const;

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/** A percentage change, or null when the previous period had nothing to compare against. */
function delta(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

/**
 * Sums one channel's metrics.
 *
 * A field stays null when no post on this channel reported it — that is the
 * network not measuring it, which is different from measuring zero, and §2.6
 * forbids rendering the two the same way.
 */
function sumChannel(
  channel: string,
  rows: {
    impressions: number | null;
    reach: number | null;
    reactions: number | null;
    comments: number | null;
    shares: number | null;
    clicks: number | null;
  }[]
): ChannelPerformance {
  const sum = (pick: (r: (typeof rows)[number]) => number | null): number | null => {
    const present = rows.map(pick).filter((v): v is number => v != null);
    return present.length === 0 ? null : present.reduce((a, b) => a + b, 0);
  };

  return {
    channel,
    postCount: rows.length,
    impressions: sum((r) => r.impressions),
    reach: sum((r) => r.reach),
    reactions: sum((r) => r.reactions),
    comments: sum((r) => r.comments),
    shares: sum((r) => r.shares),
    clicks: sum((r) => r.clicks),
  };
}

export async function getOverviewData(
  companyId: string,
  selectedChannel?: string
): Promise<OverviewData> {
  const now = new Date();
  const monthStart = startOfMonth(now);
  const prevMonthStart = new Date(monthStart.getFullYear(), monthStart.getMonth() - 1, 1);

  const [
    postsThisMonth,
    postsPrevMonth,
    pendingApproval,
    publishedThisMonth,
    publishedPrevMonth,
    channels,
    sources,
    upcomingRows,
    publishedChannelRows,
    metricRows,
  ] = await Promise.all([
    prisma.post.count({ where: { companyId, createdAt: { gte: monthStart } } }),
    prisma.post.count({
      where: { companyId, createdAt: { gte: prevMonthStart, lt: monthStart } },
    }),
    prisma.post.count({ where: { companyId, status: "pending_approval" as never } }),
    prisma.post.count({
      where: {
        companyId,
        status: { in: PUBLISHED_STATUSES as never },
        publishedAt: { gte: monthStart },
      },
    }),
    prisma.post.count({
      where: {
        companyId,
        status: { in: PUBLISHED_STATUSES as never },
        publishedAt: { gte: prevMonthStart, lt: monthStart },
      },
    }),
    // Also the source of the performance switcher's channel list, so the KPI
    // tile and the switcher can never disagree about what is configured.
    prisma.channelConfig.findMany({
      where: { companyId },
      select: { enabled: true, isActive: true, channel: true, bufferProfileId: true },
    }),
    prisma.contentSource.findMany({
      where: { companyId, type: "rss" as never },
      select: { id: true, lastFetchedAt: true },
    }),
    // Work still ahead: scheduled, awaiting a decision, or approved and queued.
    // Ordered by when it goes out, with unscheduled posts last — an unscheduled
    // draft is upcoming work, it just has no date to sort by yet.
    prisma.post.findMany({
      where: {
        companyId,
        status: { in: ["pending_approval", "approved"] as never },
      },
      orderBy: [{ scheduledFor: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
      take: 5,
      select: {
        id: true,
        companyId: true,
        channel: true,
        status: true,
        content: true,
        hashtags: true,
        imagePrompt: true,
        notes: true,
        llmProvider: true,
        llmModel: true,
        approvedById: true,
        publishedPostUrl: true,
        scheduledFor: true,
        manuallyScheduled: true,
        contentGroupId: true,
        createdAt: true,
        mediaAsset: { select: { url: true } },
        // Frozen provenance first; the join is the legacy fallback.
        originType: true,
        originSourceType: true,
        originSourceName: true,
        originSourceTitle: true,
        originSourceUrl: true,
        primaryFeedItem: {
          select: { title: true, url: true, source: { select: { name: true, type: true } } },
        },
      },
    }),
    // Which channels have ever reached Buffer. Grouped rather than counted per
    // channel so one query answers for all four.
    prisma.post.groupBy({
      by: ["channel"],
      where: { companyId, status: { in: PUBLISHED_STATUSES as never } },
      _count: { _all: true },
    }),
    prisma.postMetric.findMany({
      where: { companyId },
      select: {
        channelService: true,
        impressions: true,
        reach: true,
        reactions: true,
        comments: true,
        shares: true,
        clicks: true,
      },
    }),
  ]);

  // Feed items not yet consumed are what "new content" means to a user looking
  // at a source list — unread, not merely fetched.
  const newItemRows =
    sources.length === 0
      ? []
      : await prisma.feedItem.groupBy({
          by: ["sourceId"],
          where: {
            sourceId: { in: sources.map((s) => s.id) },
            enabled: true,
            usedInPost: false,
          },
          _count: { _all: true },
        });

  const byChannel = new Map<string, typeof metricRows>();
  for (const row of metricRows) {
    const key = row.channelService ? normalizeChannel(row.channelService) : null;
    if (!key) continue; // Buffer did not tell us the network; not attributable.
    byChannel.set(key, [...(byChannel.get(key) ?? []), row]);
  }

  const availableChannels = eligiblePerformanceChannels({
    bufferConnected: channels
      // A Buffer profile is what makes metrics obtainable. `enabled` is not
      // required: it governs future automated posting, and pausing a channel
      // must not hide the performance of what it already published.
      .filter((c) => c.isActive && c.bufferProfileId)
      .map((c) => c.channel),
    withPublishedPosts: publishedChannelRows.map((r) => r.channel),
  });
  const channel = resolvePerformanceChannel(availableChannels, selectedChannel);

  return {
    kpis: {
      postsThisMonth,
      postsThisMonthDelta: delta(postsThisMonth, postsPrevMonth),
      pendingApproval,
      published: publishedThisMonth,
      publishedDelta: delta(publishedThisMonth, publishedPrevMonth),
      connectedChannels: channels.filter((c) => c.enabled).length,
      totalChannels: channels.length,
      rssSources: sources.length,
      rssSourcesWithNewContent: newItemRows.filter((r) => r._count._all > 0).length,
    },
    upcoming: upcomingRows.map((r) => ({
      id: r.id,
      companyId: r.companyId,
      channel: r.channel.toUpperCase(),
      status: r.status.toUpperCase(),
      text: r.content,
      hashtags: r.hashtags,
      imagePrompt: r.imagePrompt,
      notes: r.notes,
      llmProvider: r.llmProvider,
      llmModel: r.llmModel,
      approvedById: r.approvedById,
      publishedPostUrl: r.publishedPostUrl,
      mediaUrl: r.mediaAsset?.url ?? null,
      // The overview's upcoming list is a read-only summary — it renders no
      // image actions, so it does not query the article image at all.
      sourceImageUrl: null,
      usingSourceImage: false,
      previousMediaUrl: null,
      origin: resolvePostOrigin(r, r.primaryFeedItem),
      scheduledFor: r.scheduledFor?.toISOString() ?? null,
      manuallyScheduled: r.manuallyScheduled,
      // Carried through truthfully even though this list never groups: the
      // upcoming panel shows what is scheduled, and a topic's three channel
      // versions are three things going out, not one.
      contentGroupId: r.contentGroupId,
      createdAt: r.createdAt.toISOString(),
    })),
    // An eligible channel with no metric rows yet sums to zero posts and all
    // nulls, which the panel renders as "no metrics collected yet" — the honest
    // answer while the first sync is still pending.
    performance: channel ? sumChannel(channel, byChannel.get(channel) ?? []) : null,
    availableChannels,
    hasMetrics: byChannel.size > 0,
    newItemsBySource: Object.fromEntries(newItemRows.map((r) => [r.sourceId, r._count._all])),
  };
}
