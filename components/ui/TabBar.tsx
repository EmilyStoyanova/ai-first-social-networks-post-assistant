import Link from "next/link";

export interface TabItem {
  label: string;
  href: string;
  count?: number;
}

interface Props {
  tabs: TabItem[];
  /** href of the active tab. */
  active: string;
  className?: string;
}

// §6.7: text tabs; active = fg + 2px accent underline; count inline in data role.
// Workspace tabs are routes → plain links with aria-current (§11).
export function TabBar({ tabs, active, className }: Props) {
  return (
    <nav
      className={["border-border overflow-x-auto border-b", className ?? ""]
        .filter(Boolean)
        .join(" ")}
    >
      <ul className="flex gap-1 whitespace-nowrap">
        {tabs.map((tab) => {
          const isActive = tab.href === active;
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={isActive ? "page" : undefined}
                className={[
                  "focus-ring duration-fast -mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2.5 transition-colors",
                  isActive
                    ? "text-body-strong border-accent text-fg"
                    : "text-body text-fg-muted hover:text-fg border-transparent",
                ].join(" ")}
              >
                {tab.label}
                {typeof tab.count === "number" && tab.count > 0 && (
                  <span className="text-data">· {tab.count}</span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
