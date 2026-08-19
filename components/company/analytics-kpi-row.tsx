import { getTranslations } from "next-intl/server";
import { ALL_CHANNELS } from "@/lib/channels/channel-scope";
import { compactCount, formatRate } from "@/lib/analytics/analytics-format";
import type {
  AnalyticsMetricTotal,
  ChannelAnalytics,
} from "@/lib/services/analytics/get-channel-analytics.service";

interface Props {
  analytics: ChannelAnalytics;
}

/** One tile. Kept local — nothing else in the product needs this exact shape. */
function Kpi({ label, value, hint }: { label: string; value: string; hint?: string | null }) {
  return (
    <div className="rounded-card border-border bg-surface shadow-card flex flex-col border px-4 py-4">
      <p className="text-fg-muted text-xs leading-snug font-medium first-letter:uppercase">
        {label}
      </p>
      <p className="text-fg mt-2 text-2xl leading-none font-semibold tabular-nums">{value}</p>
      {hint && <p className="text-fg-faint mt-1.5 text-[11px] leading-snug">{hint}</p>}
    </div>
  );
}

/**
 * The KPI row.
 *
 * Which cards appear is decided by `metricsForScope`, not here — All Channels
 * gets published posts plus the three engagement actions that mean the same
 * thing on every network, and a single channel additionally gets whichever
 * network metrics its own posts actually reported. That is why Facebook shows
 * impressions and clicks, Instagram shows reach and saves, and LinkedIn shows
 * exactly what is in its stored data with nothing hardcoded for any of them.
 *
 * A metric no post reported renders "—". Rendering it as 0 would attribute a
 * measurement to a network that never made one, and the two are different facts
 * about a post.
 */
export async function AnalyticsKpiRow({ analytics }: Props) {
  const t = await getTranslations("planner.analytics");
  const tMetric = await getTranslations("analytics");

  const hintFor = (total: AnalyticsMetricTotal): string | null => {
    if (total.value === null) return t("kpi.notReported");
    // The denominator, whenever it is not the whole set: a total drawn from 4 of
    // 11 posts is a different claim from one drawn from all 11, and the daily
    // sync means partial coverage is the normal state rather than the exception.
    return total.reported < analytics.publishedPosts
      ? t("kpi.fromPosts", { reported: total.reported, total: analytics.publishedPosts })
      : null;
  };

  /**
   * The rate carries BOTH its denominator and its coverage. The denominator is
   * what stops the number being read as comparable with another network's; the
   * coverage is what stops an average over two posts being read as the channel's.
   */
  const rateHint = (rate: NonNullable<ChannelAnalytics["engagementRate"]>): string | null => {
    if (rate.value === null) return t("kpi.notReported");

    const parts = [
      rate.basis ? tMetric("rateBasis", { basis: tMetric(rate.basis) }) : null,
      rate.reported < analytics.publishedPosts
        ? t("kpi.fromPosts", { reported: rate.reported, total: analytics.publishedPosts })
        : null,
    ].filter(Boolean);

    return parts.length > 0 ? parts.join(" · ") : null;
  };

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      <Kpi
        label={t("kpi.publishedPosts")}
        value={String(analytics.publishedPosts)}
        hint={
          analytics.postsWithMetrics < analytics.publishedPosts
            ? t("kpi.awaitingMetrics", {
                count: analytics.publishedPosts - analytics.postsWithMetrics,
              })
            : null
        }
      />

      {analytics.totals.map((total) => (
        <Kpi
          key={total.metric}
          label={tMetric(total.metric)}
          value={compactCount(total.value)}
          hint={hintFor(total)}
        />
      ))}

      {/* Never in All Channels: Buffer computes the rate against impressions on
          Facebook and reach on Instagram, so a single blended average would be
          the mean of two different ratios. */}
      {analytics.scope !== ALL_CHANNELS && analytics.engagementRate && (
        <Kpi
          label={t("kpi.avgEngagementRate")}
          value={formatRate(analytics.engagementRate.value)}
          hint={rateHint(analytics.engagementRate)}
        />
      )}

      {analytics.scope === ALL_CHANNELS && analytics.publishedPosts > 0 && (
        <div className="col-span-full">
          <p className="text-fg-faint text-xs leading-relaxed">{t("kpi.allChannelsNote")}</p>
        </div>
      )}
    </div>
  );
}
