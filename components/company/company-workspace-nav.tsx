import Link from "next/link";

export interface WorkspaceTab {
  key: string;
  label: string;
  href: string;
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
      <ul role="list" className="flex min-w-max px-4 sm:px-6 lg:px-8">
        {tabs.map((tab) => {
          const isActive = tab.key === activeTab;
          return (
            <li key={tab.key}>
              <Link
                href={tab.href}
                aria-current={isActive ? "page" : undefined}
                className={[
                  "inline-block border-b-2 px-3 pt-1.5 pb-3 text-sm font-medium whitespace-nowrap transition-colors",
                  isActive
                    ? "border-fg text-fg"
                    : "text-fg-muted hover:border-border-strong hover:text-fg border-transparent",
                ].join(" ")}
              >
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
