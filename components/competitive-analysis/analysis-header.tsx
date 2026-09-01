import { getTranslations } from "next-intl/server";
import { LayoutGrid, Users, FileText, TrendingUp } from "lucide-react";
import { CompanyWorkspaceNav, type WorkspaceTab } from "@/components/company/company-workspace-nav";

interface Props {
  slug: string;
  activeTab: string;
}

/**
 * The module's own lightweight header — title + its 4-tab sub-nav
 * (Overview | Competitors | Content | Trends). Deliberately NOT
 * `CompanyWorkspaceHeader`: Competitive Analysis is a task-oriented module
 * like Content Creation, not a company-management workspace tab (§12 of the
 * Part 3A task; §3.16 of the approved plan). Company context is already
 * visible via the global header's company selector.
 *
 * Reuses `CompanyWorkspaceNav` with its own tab set, same as the plan's
 * §3.16 instruction — the component itself has no notion of "workspace",
 * it just renders whatever tabs it is given.
 */
export async function CompetitiveAnalysisHeader({ slug, activeTab }: Props) {
  const t = await getTranslations("competitiveAnalysis");

  const tabs: WorkspaceTab[] = [
    {
      key: "overview",
      label: t("tabs.overview"),
      href: `/competitive-analysis/${slug}`,
      icon: LayoutGrid,
    },
    {
      key: "competitors",
      label: t("tabs.competitors"),
      href: `/competitive-analysis/${slug}/competitors`,
      icon: Users,
    },
    {
      key: "content",
      label: t("tabs.content"),
      href: `/competitive-analysis/${slug}/content`,
      icon: FileText,
    },
    {
      key: "trends",
      label: t("tabs.trends"),
      href: `/competitive-analysis/${slug}/trends`,
      icon: TrendingUp,
    },
  ];

  return (
    <div>
      <h1 className="text-display text-fg">{t("title")}</h1>
      <CompanyWorkspaceNav tabs={tabs} activeTab={activeTab} />
    </div>
  );
}
