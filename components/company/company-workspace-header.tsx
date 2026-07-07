import { Fragment } from "react";
import { getTranslations } from "next-intl/server";
import type { CompanyDetails } from "@/lib/services/company/get-company.service";
import { CompanyWorkspaceNav } from "./company-workspace-nav";

interface Stats {
  pendingApprovals?: number;
}

interface Props {
  company: CompanyDetails;
  activeTab: string;
  stats?: Stats;
}

function cleanUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export async function CompanyWorkspaceHeader({ company, activeTab, stats }: Props) {
  const t = await getTranslations("workspace");
  const { slug } = company;

  const tabs = [
    { key: "overview", label: t("tabs.overview"), href: `/companies/${slug}` },
    { key: "posts", label: t("tabs.posts"), href: `/companies/${slug}?tab=posts` },
    { key: "approval", label: t("tabs.approval"), href: `/companies/${slug}/approval` },
    { key: "media", label: t("tabs.media"), href: `/companies/${slug}/media` },
    { key: "sources", label: t("tabs.sources"), href: `/companies/${slug}?tab=sources` },
    { key: "team", label: t("tabs.team"), href: `/companies/${slug}?tab=team` },
    { key: "settings", label: t("tabs.settings"), href: `/companies/${slug}?tab=settings` },
    { key: "activity", label: t("tabs.activity"), href: `/companies/${slug}/audit-log` },
  ];

  type MetaItem = { key: string; node: React.ReactNode };
  const metaItems: MetaItem[] = [];

  if (company.website) {
    metaItems.push({
      key: "website",
      node: (
        <a
          href={company.website}
          target="_blank"
          rel="noopener noreferrer"
          className="text-fg-muted hover:text-fg transition-colors hover:underline"
        >
          {cleanUrl(company.website)}
        </a>
      ),
    });
  }

  if (company.role) {
    metaItems.push({
      key: "role",
      node: <span className="capitalize">{company.role.toLowerCase()}</span>,
    });
  }

  if (stats?.pendingApprovals != null && stats.pendingApprovals > 0) {
    metaItems.push({
      key: "pending",
      node: <span>{stats.pendingApprovals} pending</span>,
    });
  }

  return (
    <div>
      <div className="min-w-0">
        <h1 className="text-display text-fg">{company.name}</h1>
        {metaItems.length > 0 && (
          <div className="text-fg-faint mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            {metaItems.map((item, i) => (
              <Fragment key={item.key}>
                {i > 0 && (
                  <span className="text-border select-none" aria-hidden="true">
                    ·
                  </span>
                )}
                {item.node}
              </Fragment>
            ))}
          </div>
        )}
      </div>

      <CompanyWorkspaceNav tabs={tabs} activeTab={activeTab} />
    </div>
  );
}
