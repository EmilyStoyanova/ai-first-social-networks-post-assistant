import { getTranslations } from "next-intl/server";
import type { CompanyDetails } from "@/lib/services/company/get-company.service";
import { Badge } from "@/components/ui/Badge";
import { CompanyWorkspaceNav } from "./company-workspace-nav";

interface Props {
  company: CompanyDetails;
  activeTab: string;
}

export async function CompanyWorkspaceHeader({ company, activeTab }: Props) {
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

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-display text-fg">{company.name}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            {company.website && (
              <>
                <a
                  href={company.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:text-fg text-sm transition-colors hover:underline"
                >
                  {company.website}
                </a>
                <span className="text-border" aria-hidden="true">
                  |
                </span>
              </>
            )}
            <span className="text-fg-faint font-mono text-xs">{company.slug}</span>
          </div>
        </div>
        {company.role && (
          <div className="shrink-0 pt-1">
            <Badge variant={company.role === "OWNER" ? "owner" : "editor"}>{company.role}</Badge>
          </div>
        )}
      </div>

      <CompanyWorkspaceNav tabs={tabs} activeTab={activeTab} />
    </div>
  );
}
