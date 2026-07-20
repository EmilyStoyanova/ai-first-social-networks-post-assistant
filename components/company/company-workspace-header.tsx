import { Fragment } from "react";
import { getTranslations } from "next-intl/server";
import type { CompanyDetails } from "@/lib/services/company/get-company.service";
import { countPendingApprovals } from "@/lib/services/company/count-pending-approvals.service";
import { CompanyWorkspaceNav, type WorkspaceTab } from "./company-workspace-nav";

interface Props {
  company: CompanyDetails;
  activeTab: string;
}

function cleanUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export async function CompanyWorkspaceHeader({ company, activeTab }: Props) {
  const t = await getTranslations("workspace");
  const { slug } = company;

  // Sourced here rather than passed in, so the badge is identical on every
  // workspace page without eight callers each deciding whether to compute it.
  // One source, one number — which is what §9.4 asks for now that the filter
  // chip on Posts shows the same count.
  const pendingApprovals = await countPendingApprovals(company.id);

  // Six tabs (§9.1). Team is not one of them — it is rare-touch configuration
  // reached through the Settings sub-navigation, which Phase 4b built to hold
  // it. Approvals is no longer one either: Phase 4c folded the queue into a
  // Posts filter, so approving happens where the posts already are. Its count
  // badge came with it, because the pull signal was the tab's real job and
  // Principle 4 still needs somewhere to put it.
  const tabs: WorkspaceTab[] = [
    { key: "overview", label: t("tabs.overview"), href: `/companies/${slug}` },
    {
      key: "posts",
      label: t("tabs.posts"),
      href: `/companies/${slug}/posts`,
      count: pendingApprovals,
      countLabel: t("pendingApprovalsLabel", { count: pendingApprovals }),
    },
    { key: "media", label: t("tabs.media"), href: `/companies/${slug}/media` },
    { key: "sources", label: t("tabs.sources"), href: `/companies/${slug}/sources` },
    { key: "settings", label: t("tabs.settings"), href: `/companies/${slug}/settings` },
    { key: "activity", label: t("tabs.activity"), href: `/companies/${slug}/activity` },
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

  // No "N pending" meta item — the Posts tab badge above states the same
  // number, and two renderings of one count in one header is the disagreement
  // §9.4 warns about waiting to happen.

  return (
    <div>
      <div>
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
