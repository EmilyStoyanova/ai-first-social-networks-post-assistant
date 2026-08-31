import { Fragment } from "react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import {
  Activity,
  CalendarDays,
  FileText,
  Image as ImageIcon,
  LayoutGrid,
  Rss,
  Settings2,
  Sparkles,
} from "lucide-react";
import { RoleBadge } from "@/components/ui/RoleBadge";
import type { CompanyDetails } from "@/lib/services/company/get-company.service";
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

  // Team is not a tab — it is rare-touch configuration reached through the
  // Settings sub-navigation, which Phase 4b built to hold it. Approvals is not
  // one either: Phase 4c folded the queue into a Posts filter, so approving
  // happens where the posts already are. It carries no count badge of its
  // own any more — `pending_approval` stopped being a generation outcome, so a
  // badge here would be pulling toward a queue nothing actively feeds (see
  // lib/posts/post-status-filter.ts).
  //
  // Channels is the seventh, and it is a place rather than a filter: Posts is
  // the whole company's output as a grid, Channels is one network at a time,
  // laid out on a calendar. Its own sub-navigation (Posts / Calendar /
  // Analytics) is why it cannot be a control on the Posts tab.
  const tabs: WorkspaceTab[] = [
    { key: "overview", label: t("tabs.overview"), href: `/companies/${slug}`, icon: LayoutGrid },
    {
      key: "posts",
      label: t("tabs.posts"),
      href: `/companies/${slug}/posts`,
      icon: FileText,
    },
    {
      key: "channels",
      label: t("tabs.channels"),
      href: `/companies/${slug}/channels`,
      icon: CalendarDays,
    },
    { key: "media", label: t("tabs.media"), href: `/companies/${slug}/media`, icon: ImageIcon },
    { key: "sources", label: t("tabs.sources"), href: `/companies/${slug}/sources`, icon: Rss },
    {
      key: "settings",
      label: t("tabs.settings"),
      href: `/companies/${slug}/settings`,
      icon: Settings2,
    },
    {
      key: "activity",
      label: t("tabs.activity"),
      href: `/companies/${slug}/activity`,
      icon: Activity,
    },
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

  // No role meta item — the RoleBadge beside the title says it, and repeating
  // it in the metadata line is the same fact twice in one header.

  // No "N pending" meta item — the Posts tab badge above states the same
  // number, and two renderings of one count in one header is the disagreement
  // §9.4 warns about waiting to happen.

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-display text-fg">{company.name}</h1>
            {company.role && (
              <RoleBadge
                role={company.role.toLowerCase() as "owner" | "editor"}
                label={company.role}
              />
            )}
          </div>
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

        {/* The workspace's one primary action, in the header's action slot so
            it never floats over content (§9.3). Posts owns generation, so the
            button routes there rather than opening a panel from any tab. */}
        <Link
          href={`/companies/${slug}/posts`}
          className="bg-accent rounded-control duration-fast focus-visible:outline-accent inline-flex shrink-0 items-center gap-2 px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <Sparkles className="h-4 w-4" aria-hidden="true" />
          {t("generatePost")}
        </Link>
      </div>

      <CompanyWorkspaceNav tabs={tabs} activeTab={activeTab} />
    </div>
  );
}
