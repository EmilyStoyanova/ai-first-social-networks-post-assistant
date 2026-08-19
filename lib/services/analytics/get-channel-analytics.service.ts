import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { appZoneClock } from "@/lib/scheduling/app-datetime-local";
import { ALL_CHANNELS, type ChannelScope } from "@/lib/channels/channel-scope";
import { attributeSource } from "@/lib/analytics/analytics-source";
import {
  analyticsChannelOf,
  averageEngagementRate,
  averageMetric,
  engagementActions,
  filterByAnalyticsScope,
  metricsForScope,
  sumMetric,
  type CountMetric,
  type EngagementRateSummary,
  type MetricFigures,
} from "@/lib/analytics/analytics-metrics";
import {
  buildDailySeries,
  type DailyPoint,
  type SeriesObservation,
  type SeriesPost,
} from "@/lib/analytics/analytics-series";
import { analyticsWindowInstants, type AnalyticsRange } from "@/lib/analytics/analytics-period";

/**
 * The read behind Channels → Analytics.
 *
 * ── Why this is ONE service and not three ────────────────────────────────────
 *
 * The KPI cards, the chart, the top posts and the source table are four views of
 * exactly the same set of rows: the posts this company published inside the
 * selected period. Splitting them into `get-channel-analytics`, `get-top-posts`
 * and `get-source-performance` would run that same query three times per page
 * load, and — worse — let the three drift, so a KPI card could count nine posts
 * while the source table added up to eight. One read, four projections, no way
 * for them to disagree.
 *
 * Two queries total, both bounded by the period:
 *
 *   1. the posts, with their current metrics, media, source and origin snapshot
 *      pulled in the same call (Prisma batches a nested select per relation, not
 *      per row — no N+1);
 *   2. their snapshots, for the chart.
 *
 * No index was added for either. Query 1 is `companyId + status + publishedAt`
 * and the existing `@@index([companyId, status])` already prunes to one
 * company's published posts — a few hundred rows at the scale this product runs
 * at, with the date comparison applied to those alone. Query 2 leads on
 * `@@index([companyId, snapshotAt])`. Adding a composite index for a scan of
 * that size would be paying write cost on every publish for nothing measurable.
 *
 * ── Attribution ──────────────────────────────────────────────────────────────
 *
 * Every figure is filed under `PostMetric.channelService` — Buffer's own word
 * for where the post landed — never under `Post.channel`, which records what the
 * post was WRITTEN for. See `analyticsChannelOf`; the two have been observed
 * disagreeing on live data.
 */

/** Posts in these statuses reached Buffer and can therefore carry metrics. */
const PUBLISHED_STATUSES = ["sent_to_buffer", "published"] as const;

/** How many posts the Top Posts section shows. */
const TOP_POSTS_LIMIT = 5;

/** How much of the post body the top-post rows preview. */
const PREVIEW_LENGTH = 140;

export interface AnalyticsMetricTotal {
  metric: CountMetric;
  /** Null when no post in scope reported it — rendered "—", never 0. */
  value: number | null;
  /** How many posts reported it. The KPI's honest denominator. */
  reported: number;
}

export interface AnalyticsSeries {
  metric: CountMetric;
  points: DailyPoint[];
}

export interface TopPostView {
  id: string;
  /** Trimmed post body — enough to recognise the post by. */
  preview: string;
  /** Uppercase network, from Buffer's `channelService` where known. */
  channel: string;
  publishedAt: string;
  mediaUrl: string | null;
  /** The live post on the network, when Buffer returned one. */
  postUrl: string | null;
  /** Reactions + comments + shares — the ranking score. Null when unmeasured. */
  engagement: number | null;
  /** Only the metrics this post actually reported. */
  metrics: Array<{ metric: CountMetric; value: number }>;
  engagementRate: number | null;
  engagementRateBasis: string | null;
}

export interface SourcePerformanceView {
  key: string;
  /** Null means the company's own brand/mission content, which has no source. */
  name: string | null;
  posts: number;
  averages: Array<{ metric: CountMetric; value: number | null; reported: number }>;
}

export interface ChannelAnalytics {
  /** Echoed back so the views can apply the All-Channels rules without re-deriving them. */
  scope: ChannelScope;
  /** Posts published in the period and scope. Counts posts with no metrics too. */
  publishedPosts: number;
  /** How many of those the metrics sync has reached — the coverage note. */
  postsWithMetrics: number;
  /** The metrics this scope may show, decided by `metricsForScope`. */
  totals: AnalyticsMetricTotal[];
  /** Null in All Channels: the rate's denominator differs per network. */
  engagementRate: EngagementRateSummary | null;
  /** One entry per metric that produced a derivable series. Empty = no chart. */
  series: AnalyticsSeries[];
  topPosts: TopPostView[];
  sources: SourcePerformanceView[];
}

/** A post row reduced to what every projection below needs. */
interface ScopedPost extends MetricFigures {
  id: string;
  channel: string;
  channelService: string | null;
  publishedAt: Date;
  publishedDay: string;
  preview: string;
  mediaUrl: string | null;
  postUrl: string | null;
  engagementRate: number | null;
  engagementRateDenominator: string | null;
  sourceKey: string;
  sourceName: string | null;
}

const NO_FIGURES: MetricFigures = {
  reactions: null,
  comments: null,
  shares: null,
  impressions: null,
  clicks: null,
  reach: null,
  views: null,
  saves: null,
  follows: null,
};

/** First line-ish of the body, whitespace collapsed, cut on a word boundary. */
function previewOf(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  if (flat.length <= PREVIEW_LENGTH) return flat;

  const cut = flat.slice(0, PREVIEW_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > PREVIEW_LENGTH / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Everything the Analytics page shows, for one company, one channel scope and
 * one period.
 *
 * Access is the caller's business: the page has already resolved the company
 * through `loadChannelsContext`, which redirects or 404s before this runs.
 */
export async function getChannelAnalytics(
  companyId: string,
  scope: ChannelScope,
  range: AnalyticsRange
): Promise<ChannelAnalytics> {
  const window = analyticsWindowInstants(range);

  const postWhere: Prisma.PostWhereInput = {
    companyId,
    status: { in: [...PUBLISHED_STATUSES] },
    // Half-open on the business clock, so a post at exactly midnight belongs to
    // one period only — see `analyticsWindowInstants`.
    publishedAt: { gte: window.from, lt: window.to },
  };

  const [rows, snapshotRows] = await Promise.all([
    prisma.post.findMany({
      where: postWhere,
      orderBy: { publishedAt: "desc" },
      select: {
        id: true,
        channel: true,
        content: true,
        publishedAt: true,
        publishedPostUrl: true,
        contentSourceId: true,
        originType: true,
        originSourceType: true,
        originSourceName: true,
        originSourceTitle: true,
        originSourceUrl: true,
        mediaAsset: { select: { url: true } },
        contentSource: { select: { name: true } },
        primaryFeedItem: {
          select: { title: true, url: true, source: { select: { name: true, type: true } } },
        },
        metrics: {
          select: {
            channelService: true,
            reactions: true,
            comments: true,
            shares: true,
            impressions: true,
            clicks: true,
            reach: true,
            views: true,
            saves: true,
            follows: true,
            engagementRate: true,
            engagementRateDenominator: true,
          },
        },
      },
    }),
    // The whole snapshot history of the posts in scope, with no date bound of
    // its own. It needs none: a post published inside the period cannot have a
    // snapshot from before it, and having the FIRST-EVER observation is what
    // lets the series treat it as the post's opening total rather than as a
    // day's engagement (rule 2 in analytics-series.ts).
    prisma.postMetricSnapshot.findMany({
      where: { companyId, post: postWhere },
      orderBy: { snapshotAt: "asc" },
      select: {
        postId: true,
        snapshotAt: true,
        reactions: true,
        comments: true,
        shares: true,
        impressions: true,
        clicks: true,
        reach: true,
        views: true,
        saves: true,
        follows: true,
      },
    }),
  ]);

  const posts: ScopedPost[] = rows.flatMap((row) => {
    // The range filter already excludes NULL, so this only narrows the type —
    // but returning nothing is safer than asserting, and costs one branch.
    const published = row.publishedAt;
    if (published === null) return [];

    const metrics = row.metrics;
    const source = attributeSource(row);

    return [
      {
        id: row.id,
        channel: row.channel as string,
        channelService: metrics?.channelService ?? null,
        publishedAt: published,
        // The business-zone day, so a 22:00 Sofia post sits on the day the company
        // published it rather than on UTC's previous one.
        publishedDay: appZoneClock(published)?.day ?? published.toISOString().slice(0, 10),
        preview: previewOf(row.content),
        mediaUrl: row.mediaAsset?.url ?? null,
        postUrl: row.publishedPostUrl,
        engagementRate: metrics?.engagementRate ?? null,
        engagementRateDenominator: metrics?.engagementRateDenominator ?? null,
        sourceKey: source.key,
        sourceName: source.name,
        ...(metrics
          ? {
              reactions: metrics.reactions,
              comments: metrics.comments,
              shares: metrics.shares,
              impressions: metrics.impressions,
              clicks: metrics.clicks,
              reach: metrics.reach,
              views: metrics.views,
              saves: metrics.saves,
              follows: metrics.follows,
            }
          : NO_FIGURES),
      },
    ];
  });

  const scoped = filterByAnalyticsScope(posts, scope);
  const inScope = new Set(scoped.map((p) => p.id));

  // ── KPI cards ──────────────────────────────────────────────────────────────
  const metrics = metricsForScope(scoped, scope);
  const totals: AnalyticsMetricTotal[] = metrics.map((metric) => ({
    metric,
    value: sumMetric(scoped, metric),
    reported: scoped.filter((post) => post[metric] != null).length,
  }));

  // Never in All Channels: Buffer computes the rate against impressions on
  // Facebook and reach on Instagram, so one average would blend two ratios.
  const engagementRate = scope === ALL_CHANNELS ? null : averageEngagementRate(scoped);

  // ── Chart ──────────────────────────────────────────────────────────────────
  const seriesPosts: SeriesPost[] = scoped.map((post) => ({
    id: post.id,
    publishedDay: post.publishedDay,
  }));

  // The business-zone day is resolved ONCE per snapshot rather than inside the
  // per-metric loop below. `appZoneClock` goes through `Intl.DateTimeFormat`,
  // and a year's history for an active company is tens of thousands of rows —
  // formatting each of them nine times over would dominate the whole request.
  const scopedSnapshots = snapshotRows
    .filter((row) => inScope.has(row.postId))
    .map((row) => ({
      ...row,
      day: appZoneClock(row.snapshotAt)?.day ?? row.snapshotAt.toISOString().slice(0, 10),
    }));

  const series: AnalyticsSeries[] = [];
  for (const metric of metrics) {
    const observations: SeriesObservation[] = scopedSnapshots.map((row) => ({
      postId: row.postId,
      day: row.day,
      value: row[metric],
    }));

    const derived = buildDailySeries({ days: range.days, posts: seriesPosts, observations });
    // A metric with nothing derivable is left out of the switcher entirely,
    // rather than offered as a flat line at zero that looks like a real answer.
    if (derived.hasData) series.push({ metric, points: derived.points });
  }

  // ── Top posts ──────────────────────────────────────────────────────────────
  //
  // Ranked by engagement ACTIONS — reactions + comments + shares — in every
  // scope, including a single channel. That is the one score with the same
  // definition on every network, so All Channels never compares a Facebook
  // engagement rate against an Instagram one, and the ranking key does not
  // change under the user as sparse rate data trickles in from the daily sync.
  // The rate is still shown on each row; it is just never what orders them.
  // Ties break on the engagement rate within a single channel (comparable there
  // — same denominator) and on recency in All Channels (where it is not).
  const topPosts: TopPostView[] = scoped
    .map((post) => ({ post, engagement: engagementActions(post) }))
    .filter((entry): entry is { post: ScopedPost; engagement: number } => entry.engagement !== null)
    .sort((a, b) => {
      if (b.engagement !== a.engagement) return b.engagement - a.engagement;
      if (scope !== ALL_CHANNELS) {
        const rate = (b.post.engagementRate ?? -1) - (a.post.engagementRate ?? -1);
        if (rate !== 0) return rate;
      }
      return b.post.publishedAt.getTime() - a.post.publishedAt.getTime();
    })
    .slice(0, TOP_POSTS_LIMIT)
    .map(({ post, engagement }) => ({
      id: post.id,
      preview: post.preview,
      channel: analyticsChannelOf(post),
      publishedAt: post.publishedAt.toISOString(),
      mediaUrl: post.mediaUrl,
      postUrl: post.postUrl,
      engagement,
      metrics: metrics
        .map((metric) => ({ metric, value: post[metric] }))
        .filter((m): m is { metric: CountMetric; value: number } => m.value != null),
      engagementRate: scope === ALL_CHANNELS ? null : post.engagementRate,
      engagementRateBasis: scope === ALL_CHANNELS ? null : post.engagementRateDenominator,
    }));

  // ── Performance by source ──────────────────────────────────────────────────
  const bySource = new Map<string, ScopedPost[]>();
  for (const post of scoped) {
    const group = bySource.get(post.sourceKey);
    if (group) group.push(post);
    else bySource.set(post.sourceKey, [post]);
  }

  const sources: SourcePerformanceView[] = [...bySource.entries()]
    .map(([key, group]) => ({
      key,
      name: group[0].sourceName,
      posts: group.length,
      // Averages divide by the posts that REPORTED each metric, never by the
      // size of the group — see `averageMetric`.
      averages: metrics.map((metric) => ({ metric, ...averageMetric(group, metric) })),
    }))
    .sort((a, b) => b.posts - a.posts || (a.name ?? "").localeCompare(b.name ?? ""));

  return {
    scope,
    publishedPosts: scoped.length,
    // Buffer writes `channelService` only on a SUCCESSFUL read, so its presence
    // is the one honest answer to "has the sync reached this post?".
    postsWithMetrics: scoped.filter((post) => post.channelService !== null).length,
    totals,
    engagementRate,
    series,
    topPosts,
    sources,
  };
}
