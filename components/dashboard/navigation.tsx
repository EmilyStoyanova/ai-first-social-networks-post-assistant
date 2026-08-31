"use client";

import { LayoutDashboard, Sparkles, LineChart, ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { NavigationItem } from "./navigation-item";

interface Props {
  isGlobalAdmin: boolean;
}

/**
 * The global product nav — task-oriented, not company-oriented (§ Final
 * global navigation). Companies is deliberately absent: it isn't a task, it's
 * the context a task runs in, represented instead by the header's company
 * selector.
 */
export function Navigation({ isGlobalAdmin }: Props) {
  const t = useTranslations("navigation");

  const NAV_ITEMS = [
    { label: t("dashboard"), href: "/dashboard", icon: LayoutDashboard },
    { label: t("contentCreation"), href: "/create", icon: Sparkles },
    { label: t("competitiveAnalysis"), href: "/competitive-analysis", icon: LineChart },
  ];

  return (
    <nav aria-label={t("mainNavigation")}>
      <ul role="list" className="flex items-center gap-x-1">
        {NAV_ITEMS.map((item) => (
          <li key={item.href}>
            <NavigationItem
              href={item.href}
              label={item.label}
              icon={item.icon}
              variant="horizontal"
            />
          </li>
        ))}
        {isGlobalAdmin && (
          <li>
            <NavigationItem
              href="/admin"
              label={t("adminPanel")}
              icon={ShieldCheck}
              variant="horizontal"
            />
          </li>
        )}
      </ul>
    </nav>
  );
}
