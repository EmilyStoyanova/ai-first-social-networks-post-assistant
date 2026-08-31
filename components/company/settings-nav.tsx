"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

export type SettingsSection = "channels" | "buffer" | "team";

interface Props {
  slug: string;
  active: SettingsSection;
}

/**
 * Sub-navigation within Settings (§2.4).
 *
 * A list on desktop and a select below `lg`, rather than a second row of tabs:
 * the workspace tab bar sits directly above, and two tab treatments stacked
 * would leave "which level am I on?" unanswerable. Brand was moved out to its
 * own direct workspace tab (edited far more often than these three) — what
 * remains here is genuinely rare-touch: Channels (which needs Buffer), then
 * Buffer, then Team, which is optional.
 *
 * The active section is passed in rather than derived from the pathname: every
 * settings page already knows which one it is, and reading it from props keeps
 * this from disagreeing with the page that rendered it.
 */
export function SettingsNav({ slug, active }: Props) {
  const router = useRouter();
  const t = useTranslations("companyPage.sections");
  const tWorkspace = useTranslations("workspace");

  const items: { key: SettingsSection; label: string; href: string }[] = [
    { key: "channels", label: t("channels"), href: `/companies/${slug}/settings/channels` },
    { key: "buffer", label: t("integrations"), href: `/companies/${slug}/settings/buffer` },
    { key: "team", label: tWorkspace("tabs.team"), href: `/companies/${slug}/settings/team` },
  ];

  return (
    <>
      {/* Mobile / tablet: a select, because a 4-item sidebar would eat the width
          the forms need. */}
      <div className="lg:hidden">
        <label htmlFor="settings-section" className="sr-only">
          {tWorkspace("tabs.settings")}
        </label>
        <select
          id="settings-section"
          value={active}
          onChange={(e) => {
            const next = items.find((i) => i.key === e.target.value);
            if (next) router.push(next.href);
          }}
          className="rounded-control border-border-strong bg-surface duration-fast focus:border-accent focus:ring-accent/20 w-full border px-3.5 py-2.5 text-sm transition-all outline-none focus:ring-2 focus:ring-offset-0"
        >
          {items.map((item) => (
            <option key={item.key} value={item.key}>
              {item.label}
            </option>
          ))}
        </select>
      </div>

      <nav aria-label={tWorkspace("tabs.settings")} className="hidden lg:block">
        <ul role="list" className="space-y-0.5">
          {items.map((item) => {
            const isActive = item.key === active;
            return (
              <li key={item.key}>
                <Link
                  href={item.href}
                  aria-current={isActive ? "page" : undefined}
                  className={[
                    "rounded-control duration-fast focus-visible:outline-accent block px-3 py-2 text-sm font-medium transition-colors outline-none focus-visible:outline-2",
                    isActive
                      ? "bg-surface-subtle text-fg"
                      : "text-fg-muted hover:bg-surface-subtle hover:text-fg",
                  ].join(" ")}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
