import { getTranslations } from "next-intl/server";
import { BarChart3 } from "lucide-react";
import type { ChannelPerformance } from "@/lib/services/company/get-overview-data.service";
import { OverviewPanel } from "./overview-panel";
import { ChannelMonogram } from "./channel-monogram";

interface Props {
  slug: string;
  performance: ChannelPerformance | null;
  availableChannels: string[];
  analyticsConfigured: boolean;
  canManageKey: boolean;
}

const CHANNEL_LABELS: Record<string, string> = {
  FACEBOOK: "Facebook",
  LINKEDIN: "LinkedIn",
  INSTAGRAM: "Instagram",
  TIKTOK: "TikTok",
};

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

/**
 * Company performance for **one** channel.
 *
 * There is deliberately no "all channels" option. Buffer's metrics are not
 * comparable across networks — `engagementRate` uses impressions as its
 * denominator on Facebook and reach on Instagram, and the raw fields are sparse
 * by network (impressions/clicks Facebook-only, reach Instagram-only in
 * observed data). A blended total would add quantities that measure different
 * things and label the sum as if it measured one, which §2.6 forbids.
 *
 * Metrics absent for a network are omitted rather than rendered as 0 — "not
 * measured" and "measured zero" are different facts about a post.
 *
 * No trend chart: metrics are stored per post, and no company-wide daily series
 * exists to plot. A chart here would have to invent its own history.
 */
export async function OverviewPerformance({
  slug,
  performance,
  availableChannels,
  analyticsConfigured,
  canManageKey,
}: Props) {
  const t = await getTranslations("overview.performance");

  const metrics = performance
    ? (
        [
          ["impressions", performance.impressions],
          ["reach", performance.reach],
          ["reactions", performance.reactions],
          ["comments", performance.comments],
          ["shares", performance.shares],
          ["clicks", performance.clicks],
        ] as const
      ).filter(([, value]) => value != null)
    : [];

  return (
    <OverviewPanel
      icon={BarChart3}
      title={t("title")}
      action={
        performance && availableChannels.length > 0 ? (
          <span className="bg-surface-subtle text-fg-muted rounded-control inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium">
            <ChannelMonogram channel={performance.channel} className="h-5 w-5 text-[9px]" />
            {CHANNEL_LABELS[performance.channel] ?? performance.channel}
          </span>
        ) : null
      }
      footerHref={`/companies/${slug}/posts?status=published`}
      footerLabel={t("viewPosts")}
    >
      {!analyticsConfigured ? (
        <div className="py-8 text-center">
          <p className="text-fg-muted text-sm">{t("notConfigured")}</p>
          {canManageKey && (
            <p className="text-fg-faint mt-1.5 text-xs">{t("notConfiguredOwnerHint")}</p>
          )}
        </div>
      ) : metrics.length === 0 ? (
        <p className="text-fg-faint py-8 text-center text-sm">{t("noData")}</p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-5 py-1 sm:grid-cols-3">
            {metrics.map(([key, value]) => (
              <div key={key}>
                <dt className="text-fg-faint text-xs font-medium">{t(`metrics.${key}`)}</dt>
                <dd className="text-fg mt-1 text-2xl leading-none font-semibold tabular-nums">
                  {compact(value as number)}
                </dd>
              </div>
            ))}
          </dl>
          <p className="text-fg-faint mt-5 text-xs leading-relaxed">
            {t("scopeNote", {
              channel: CHANNEL_LABELS[performance!.channel] ?? performance!.channel,
              count: performance!.postCount,
            })}
          </p>
        </>
      )}
    </OverviewPanel>
  );
}
