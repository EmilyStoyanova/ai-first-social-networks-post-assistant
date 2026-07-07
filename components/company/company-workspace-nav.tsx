import Link from "next/link";

export interface WorkspaceTab {
  key: string;
  label: string;
  href: string;
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
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
