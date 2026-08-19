import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { BarChart3, KeyRound, LineChart } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Section } from "@/components/ui/Section";
import { ChannelsShell } from "@/components/company/channels-shell";
import { AnalyticsPeriodFilter } from "@/components/company/analytics-period-filter";
import { AnalyticsKpiRow } from "@/components/company/analytics-kpi-row";
import { AnalyticsTrendChart } from "@/components/company/analytics-trend-chart";
import { AnalyticsTopPosts } from "@/components/company/analytics-top-posts";
import { AnalyticsSourceTable } from "@/components/company/analytics-source-table";
import { getAnalyticsKeyStatus } from "@/lib/services/analytics/manage-analytics-key.service";
import { getChannelAnalytics } from "@/lib/services/analytics/get-channel-analytics.service";
import {
  ANALYTICS_PERIOD_PARAM,
  analyticsPeriodQuery,
  buildAnalyticsRange,
  resolveAnalyticsPeriod,
} from "@/lib/analytics/analytics-period";
import { channelScopeSlug } from "@/lib/channels/channel-scope";
import { appZoneToday } from "@/lib/scheduling/app-datetime-local";
import { loadChannelsContext } from "../../context";

interface Props {
  params: Promise<{ slug: string; channel: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Channel analytics – ${slug} – AI-First Post Assistant` };
}

/**
 * Per-channel analytics.
 *
 * Built entirely on what the metrics sync already stores — `PostMetric` for
 * current totals, `PostMetricSnapshot` for history. Nothing here calls Buffer,
 * and no table was added for it.
 *
 * Two things are decided at this level and nowhere else:
 *
 *  • **The period lives in the URL.** Server rendered from `?period=`, so a view
 *    is shareable and the back button works, and carried across a channel switch
 *    through `ChannelsShell`'s `query` prop — someone comparing Facebook with
 *    Instagram over a quarter means to change the network, not the period.
 *
 *  • **"Not configured" is a different screen from "no data".** A company with
 *    no Buffer Personal API Key has analytics switched off, which an owner can
 *    fix and an editor cannot; a company with a key but no synced posts yet is
 *    simply early. Showing the second message to the first company would send an
 *    owner looking for a bug instead of for the settings page.
 */
export default async function ChannelAnalyticsPage({ params, searchParams }: Props) {
  const [{ slug, channel: channelParam }, sp] = await Promise.all([params, searchParams]);

  const period = resolveAnalyticsPeriod(sp[ANALYTICS_PERIOD_PARAM]);
  // Canonical rather than passed through, exactly as the calendar does it: the
  // channel switcher's links state the period, so a network change keeps it.
  const query = analyticsPeriodQuery(period);

  const context = await loadChannelsContext(slug, channelParam, "analytics", query);
  const { company, scopes, scope, role, user } = context;

  const t = await getTranslations("planner");

  // "Today" is today where the COMPANY is, not in UTC — the two disagree for
  // three hours every evening, which is exactly when someone opening this page
  // would otherwise be shown a period ending yesterday.
  const range = buildAnalyticsRange(period, appZoneToday(new Date()));

  const [keyStatus, analytics] = await Promise.all([
    getAnalyticsKeyStatus(slug, user.id, user.isGlobalAdmin),
    getChannelAnalytics(company.id, scope, range),
  ]);

  // The key-status service is owner-scoped and answers FORBIDDEN to an editor.
  // That is a permission fact, not a setup fact, so it must not be read as "no
  // key configured" — an editor still sees whatever metrics exist. The fallback
  // asks whether any post has been synced, which is the only thing an editor can
  // observe for themselves.
  const analyticsConfigured = keyStatus.success
    ? keyStatus.data.configured
    : analytics.postsWithMetrics > 0;

  const basePath = `/companies/${slug}/channels/${channelScopeSlug(scope)}/analytics`;
  const isOwner = role === "owner";

  const body = () => {
    if (!analyticsConfigured) {
      return (
        <EmptyState
          icon={<KeyRound className="h-5 w-5" />}
          title={t("analytics.notConfigured.title")}
          description={
            isOwner
              ? t("analytics.notConfigured.ownerDescription")
              : t("analytics.notConfigured.editorDescription")
          }
          action={
            // Editors are not offered a settings link they cannot act on.
            isOwner ? (
              <Button href={`/companies/${slug}/settings/buffer`}>
                {t("analytics.notConfigured.ownerAction")}
              </Button>
            ) : null
          }
        />
      );
    }

    if (analytics.publishedPosts === 0) {
      return (
        <EmptyState
          icon={<BarChart3 className="h-5 w-5" />}
          title={t("analytics.noPosts.title")}
          description={t("analytics.noPosts.description")}
        />
      );
    }

    return (
      <div className="space-y-8">
        <AnalyticsKpiRow analytics={analytics} />

        <Section title={t("analytics.chart.title")} description={t("analytics.chart.description")}>
          {analytics.series.length > 0 ? (
            <AnalyticsTrendChart series={analytics.series} days={range.days} />
          ) : (
            /* Not enough history to derive a single day, which is the normal
               state for a young company: a delta needs two observations of the
               same post, and the sync makes one per post per day. A flat line at
               zero would be a fabricated answer. */
            <EmptyState
              icon={<LineChart className="h-5 w-5" />}
              title={t("analytics.chart.emptyTitle")}
              description={t("analytics.chart.emptyDescription")}
            />
          )}
        </Section>

        <Section
          title={t("analytics.topPosts.title")}
          description={t("analytics.topPosts.description")}
        >
          {analytics.topPosts.length > 0 ? (
            <AnalyticsTopPosts posts={analytics.topPosts} />
          ) : (
            <EmptyState
              icon={<BarChart3 className="h-5 w-5" />}
              title={t("analytics.topPosts.emptyTitle")}
              description={t("analytics.topPosts.emptyDescription")}
            />
          )}
        </Section>

        <Section
          title={t("analytics.sources.title")}
          description={t("analytics.sources.description")}
        >
          <AnalyticsSourceTable
            sources={analytics.sources}
            metrics={analytics.totals.map((total) => total.metric)}
          />
        </Section>
      </div>
    );
  };

  return (
    <ChannelsShell
      company={company}
      user={{ name: user.name, email: user.email, isGlobalAdmin: user.isGlobalAdmin }}
      scopes={scopes}
      scope={scope}
      view="analytics"
      query={query}
    >
      <div className="space-y-6">
        <AnalyticsPeriodFilter
          basePath={basePath}
          period={period}
          startDay={range.startDay}
          endDay={range.endDay}
        />
        {body()}
      </div>
    </ChannelsShell>
  );
}
