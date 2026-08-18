import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { CalendarDays, FileText, LineChart } from "lucide-react";
import { DashboardLayout } from "@/components/dashboard/dashboard-layout";
import { CompanyWorkspaceHeader } from "@/components/company/company-workspace-header";
import { TabBar, type TabItem } from "@/components/ui/TabBar";
import { ALL_CHANNELS, channelScopeSlug, type ChannelScope } from "@/lib/channels/channel-scope";
import { channelLabel } from "@/lib/posts/channel-selection";
import type { CompanyDetails } from "@/lib/services/company/get-company.service";

export type ChannelsView = "posts" | "calendar" | "analytics";

interface Props {
  company: CompanyDetails;
  user: { name?: string | null; email?: string | null; isGlobalAdmin?: boolean };
  /** Every scope the switcher offers — `ALL_CHANNELS` first, from `channelScopeOptions`. */
  scopes: ChannelScope[];
  scope: ChannelScope;
  view: ChannelsView;
  /**
   * The query string to carry across a CHANNEL switch, without the leading "?".
   *
   * The calendar's week, view and status filter live in the URL, and a person
   * comparing Facebook and Instagram for one week means to change the channel,
   * not to be thrown back to today. Only the calendar passes it; the other two
   * views have no view state to preserve.
   */
  query?: string;
  children: React.ReactNode;
}

/**
 * Chrome shared by every page in the Channels area: workspace header, the
 * channel switcher, and the Posts / Calendar / Analytics tabs.
 *
 * A component rather than a route `layout.tsx`, for the reason SettingsShell is
 * one: each page already loads the company and its channel configs for its own
 * data, and a layout would repeat both queries per request — Prisma calls are
 * not deduplicated the way `fetch` is.
 *
 * Two levels of navigation, deliberately treated differently. The channel
 * switcher is a pill group, because choosing a network narrows what the page
 * below shows rather than moving to a different kind of page; the views are the
 * underlined tab treatment, because they are different pages. Stacking two tab
 * bars under the workspace tabs would leave "which level am I on?"
 * unanswerable — the same reasoning behind SettingsNav's select-and-list.
 */
export async function ChannelsShell({
  company,
  user,
  scopes,
  scope,
  view,
  query,
  children,
}: Props) {
  const tNav = await getTranslations("navigation");
  const t = await getTranslations("planner");
  const { slug } = company;

  const suffix = query ? `?${query}` : "";
  const base = `/companies/${slug}/channels`;

  // The three views, in one list so the tabs and the active one are derived from
  // the same source — a hand-written `active` href would be a second spelling of
  // the same URL, and one typo away from no tab looking selected.
  const views: { key: ChannelsView; label: string; icon: typeof FileText }[] = [
    { key: "posts", label: t("tabs.posts"), icon: FileText },
    { key: "calendar", label: t("tabs.calendar"), icon: CalendarDays },
    { key: "analytics", label: t("tabs.analytics"), icon: LineChart },
  ];

  const hrefFor = (key: ChannelsView) => `${base}/${channelScopeSlug(scope)}/${key}`;
  const tabs: TabItem[] = views.map((item) => ({ label: item.label, href: hrefFor(item.key) }));

  const ViewIcon = views.find((item) => item.key === view)?.icon ?? CalendarDays;

  return (
    <DashboardLayout
      user={user}
      breadcrumb={[{ label: tNav("companies"), href: "/companies" }, { label: company.name }]}
    >
      <div>
        <CompanyWorkspaceHeader company={company} activeTab="channels" />

        <div className="mt-8">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-fg-faint inline-flex items-center gap-1.5 text-xs font-semibold tracking-wide uppercase">
              <ViewIcon className="h-3.5 w-3.5" aria-hidden="true" />
              {t("title")}
            </span>

            <nav
              aria-label={t("scope.label")}
              className="border-border bg-surface rounded-control flex flex-wrap items-center gap-1 border p-1"
            >
              {scopes.map((option) => {
                const isActive = option === scope;
                return (
                  <Link
                    key={option}
                    href={`${base}/${channelScopeSlug(option)}/${view}${suffix}`}
                    aria-current={isActive ? "page" : undefined}
                    className={[
                      "rounded-control duration-fast focus-visible:outline-accent inline-flex h-7 items-center px-2.5 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:outline-2",
                      isActive
                        ? "bg-fg text-bg"
                        : "text-fg-muted hover:bg-surface-subtle hover:text-fg",
                    ].join(" ")}
                  >
                    {option === ALL_CHANNELS ? t("scope.all") : channelLabel(option)}
                  </Link>
                );
              })}
            </nav>
          </div>

          <TabBar tabs={tabs} active={hrefFor(view)} className="mt-4" />

          <div className="mt-6">{children}</div>
        </div>
      </div>
    </DashboardLayout>
  );
}
