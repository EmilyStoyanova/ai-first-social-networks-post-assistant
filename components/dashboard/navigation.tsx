"use client";

import { LayoutDashboard, Settings2, LineChart, ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { NavigationItem } from "./navigation-item";
import { COMPANY_MANAGEMENT_HREF } from "@/lib/navigation/nav-active";

interface Props {
  isGlobalAdmin: boolean;
}

/**
 * The global product nav.
 *
 * Company Management — "manage the company I'm currently working in", a shim
 * that resolves the active company from the header's selector and lands on
 * its workspace. See `app/(dashboard)/create/page.tsx` and
 * `lib/navigation/nav-active.ts` for why it needs a deliberate active-state
 * rule rather than a prefix match.
 *
 * The href stays `/create` rather than a company-specific URL because this is
 * a client component with no session or cookie access — the active company can
 * only be resolved server-side, which is exactly what the shim does.
 *
 * "Companies" (the full list, `/companies`) was removed from here 2026-09-03
 * — switching between companies now happens from the header's CompanySelector
 * dropdown, which already lists every accessible company. `/companies` and
 * `/companies/new` stay reachable (dashboard quick action, selector's
 * "+ Add company"), just not as a top-level nav destination anymore.
 */
export function Navigation({ isGlobalAdmin }: Props) {
  const t = useTranslations("navigation");

  const NAV_ITEMS = [
    { label: t("dashboard"), href: "/dashboard", icon: LayoutDashboard },
    { label: t("companyManagement"), href: COMPANY_MANAGEMENT_HREF, icon: Settings2 },
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
