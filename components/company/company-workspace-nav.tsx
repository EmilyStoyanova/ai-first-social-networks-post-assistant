import Link from "next/link";
import type { LucideIcon } from "lucide-react";

export interface WorkspaceTab {
  key: string;
  label: string;
  href: string;
  /** Leading icon. Always paired with the label, never replacing it (§1.12). */
  icon?: LucideIcon;
  /**
   * Optional count beside the label. Exactly one tab carries one (§9.1) —
   * Posts, for pending approvals. One badge is a signal; five are wallpaper.
   * Zero is not rendered: a badge saying "0" is a pull signal for nothing.
   */
  count?: number;
  /** Full-sentence accessible name for the count, e.g. "4 posts awaiting approval". */
  countLabel?: string;
}

interface Props {
  tabs: WorkspaceTab[];
  activeTab: string;
}

export function CompanyWorkspaceNav({ tabs, activeTab }: Props) {
  return (
    <nav
      className="border-border -mx-4 mt-5 overflow-x-auto border-b sm:-mx-6 lg:-mx-8"
      aria-label="Company workspace"
    >
      <ul role="list" className="flex min-w-max gap-1 px-4 sm:px-6 lg:px-8">
        {tabs.map((tab) => {
          const isActive = tab.key === activeTab;
          const Icon = tab.icon;
          return (
            <li key={tab.key}>
              <Link
                href={tab.href}
                aria-current={isActive ? "page" : undefined}
                className={[
                  "duration-fast inline-flex items-center gap-2 border-b-2 px-3 pt-1.5 pb-3 text-sm font-medium whitespace-nowrap transition-colors",
                  isActive
                    ? "border-accent text-fg"
                    : "text-fg-muted hover:border-border-strong hover:text-fg border-transparent",
                ].join(" ")}
              >
                {Icon && (
                  <Icon
                    className={`h-4 w-4 shrink-0 ${isActive ? "text-accent" : ""}`}
                    aria-hidden="true"
                  />
                )}
                {tab.label}
                {tab.count != null && tab.count > 0 && (
                  <span
                    className={[
                      "ml-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-semibold tabular-nums",
                      isActive ? "bg-fg text-bg" : "bg-surface-subtle text-fg-muted",
                    ].join(" ")}
                  >
                    <span aria-hidden="true">{tab.count}</span>
                    <span className="sr-only">{tab.countLabel ?? String(tab.count)}</span>
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
