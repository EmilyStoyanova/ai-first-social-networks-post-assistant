import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { CheckCircle2, Clock, FileText, Radio, Users } from "lucide-react";
import { auth } from "@/lib/auth";
import { getCompany } from "@/lib/services/company/get-company.service";
import { getBrandGuidelines } from "@/lib/services/company/get-brand-guidelines.service";
import { getBufferConnection } from "@/lib/services/buffer/get-buffer-connection.service";
import { listChannelConfigs } from "@/lib/services/company/list-channel-configs.service";
import { listContentSources } from "@/lib/services/company/list-content-sources.service";
import { getOverviewData } from "@/lib/services/company/get-overview-data.service";
import { getAnalyticsKeyStatus } from "@/lib/services/analytics/manage-analytics-key.service";
import { listCompanyAuditLogs } from "@/lib/services/audit/audit-log.service";
import { DashboardLayout } from "@/components/dashboard/dashboard-layout";
import { CompanyWorkspaceHeader } from "@/components/company/company-workspace-header";
import { SetupChecklist } from "@/components/company/setup-checklist";
import { OverviewStatCard } from "@/components/company/overview-stat-card";
import { OverviewUpcoming } from "@/components/company/overview-upcoming";
import { OverviewPerformance } from "@/components/company/overview-performance";
import { OverviewSources, type OverviewSourceRow } from "@/components/company/overview-sources";
import { OverviewActivity } from "@/components/company/overview-activity";
import { resolveLegacyTabRedirect } from "@/lib/companies/legacy-tab-redirect";
import { pendingApprovalsHref } from "@/lib/posts/post-status-filter";

interface Props {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `${slug} – AI-First Post Assistant` };
}

/** RSS feeds show their host, which is what a user recognises a feed by. */
function hostOf(config: Record<string, string | boolean>): string | null {
  const url = typeof config.url === "string" ? config.url : null;
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export default async function CompanyPage({ params, searchParams }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const [{ slug }, sp] = await Promise.all([params, searchParams]);

  // Until Phase 4a the workspace tabs were `?tab=` query parameters on this
  // page. Bookmarks and shared links still carry them, so they are translated
  // into their route here rather than silently landing on the overview.
  const legacyDestination = resolveLegacyTabRedirect(slug, sp);
  if (legacyDestination) redirect(legacyDestination);

  const company = await getCompany(slug, session.user.id, session.user.isGlobalAdmin);
  if (!company) notFound();

  const tNav = await getTranslations("navigation");
  const t = await getTranslations("overview");
  const canManage = company.role === "OWNER" || session.user.isGlobalAdmin;

  const channelParam = Array.isArray(sp.channel) ? sp.channel[0] : sp.channel;

  const [
    brandGuidelines,
    bufferConnection,
    channelConfigs,
    contentSources,
    overview,
    analyticsStatus,
    activity,
  ] = await Promise.all([
    getBrandGuidelines(company.id),
    getBufferConnection(company.id),
    listChannelConfigs(slug, session.user.id, session.user.isGlobalAdmin),
    listContentSources(slug, session.user.id, session.user.isGlobalAdmin),
    getOverviewData(company.id, channelParam),
    getAnalyticsKeyStatus(slug, session.user.id, session.user.isGlobalAdmin),
    listCompanyAuditLogs(company.id, { limit: 5 }),
  ]);

  const configs = channelConfigs?.success ? channelConfigs.configs : [];
  const sources = contentSources?.success ? contentSources.sources : [];

  // The key-status service is owner-scoped and answers FORBIDDEN to an editor.
  // That is a permission fact, not a setup fact, so it must not be read as
  // "no key configured" — an editor still sees whatever metrics exist (§2.4).
  const analyticsReadable = analyticsStatus.success;
  const analyticsConfigured = analyticsReadable
    ? analyticsStatus.data.configured
    : overview.availableChannels.length > 0;

  const rssRows: OverviewSourceRow[] = sources
    .filter((s) => s.type === "rss")
    .slice(0, 4)
    .map((s) => ({
      id: s.id,
      name: s.name,
      host: hostOf(s.config),
      enabled: s.enabled,
      newItemCount: overview.newItemsBySource[s.id] ?? 0,
      lastFetchedAt: s.lastFetchedAt,
    }));

  const { kpis } = overview;

  return (
    <DashboardLayout
      user={{
        name: session.user.name,
        email: session.user.email,
        isGlobalAdmin: session.user.isGlobalAdmin,
      }}
      breadcrumb={[{ label: tNav("companies"), href: "/companies" }, { label: company.name }]}
    >
      <div>
        <CompanyWorkspaceHeader company={company} activeTab="overview" />

        <div className="mt-8 space-y-6">
          {/* Onboarding scaffold — disappears permanently once outgrown (§9.3). */}
          <SetupChecklist
            slug={slug}
            brandDescribed={!!brandGuidelines?.companyDescription?.trim()}
            bufferConnected={bufferConnection?.connected ?? false}
            profilesSynced={!!bufferConnection?.lastProfileSyncAt}
            hasEnabledChannel={configs.some((c) => c.enabled)}
          />

          {/* KPI row — each tile routes into the work it counts (§9.3). */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            <OverviewStatCard
              icon={FileText}
              tone="accent"
              label={t("kpis.postsThisMonth")}
              value={kpis.postsThisMonth}
              delta={kpis.postsThisMonthDelta}
              hint={t("kpis.vsLastMonth")}
              href={`/companies/${slug}/posts`}
            />
            <OverviewStatCard
              icon={Clock}
              tone="warning"
              label={t("kpis.pendingApproval")}
              value={kpis.pendingApproval}
              hint={t("kpis.reviewAndApprove")}
              href={pendingApprovalsHref(slug)}
            />
            <OverviewStatCard
              icon={CheckCircle2}
              tone="success"
              label={t("kpis.published")}
              value={kpis.published}
              delta={kpis.publishedDelta}
              hint={t("kpis.vsLastMonth")}
              href={`/companies/${slug}/posts?status=published`}
            />
            <OverviewStatCard
              icon={Users}
              tone="info"
              label={t("kpis.connectedChannels")}
              value={kpis.connectedChannels}
              hint={t("kpis.ofTotalChannels", { total: kpis.totalChannels })}
              href={`/companies/${slug}/settings/channels`}
            />
            <OverviewStatCard
              icon={Radio}
              tone="neutral"
              label={t("kpis.rssSources")}
              value={kpis.rssSources}
              hint={t("kpis.withNewContent", { count: kpis.rssSourcesWithNewContent })}
              href={`/companies/${slug}/sources`}
            />
          </div>

          {/* Two-column dashboard: work to do left, evidence right. */}
          <div className="grid gap-6 lg:grid-cols-2">
            <OverviewUpcoming slug={slug} posts={overview.upcoming} />
            <OverviewPerformance
              slug={slug}
              performance={overview.performance}
              availableChannels={overview.availableChannels}
              analyticsConfigured={analyticsConfigured}
              canManageKey={canManage}
            />
            <OverviewSources slug={slug} sources={rssRows} />
            <OverviewActivity slug={slug} entries={activity} />
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
