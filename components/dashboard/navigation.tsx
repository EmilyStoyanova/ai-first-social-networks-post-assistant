"use client";

import { LayoutDashboard, Building2, Settings2, LineChart, ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { NavigationItem } from "./navigation-item";
import { COMPANIES_HREF, COMPANY_MANAGEMENT_HREF } from "@/lib/navigation/nav-active";

interface Props {
  isGlobalAdmin: boolean;
}

/**
 * The global product nav.
 *
 * Two company entries, answering two different questions:
 *   Companies          — "which companies exist / let me add one" (the list).
 *   Company Management — "manage the company I'm currently working in", a shim
 *                        that resolves the active company from the header's
 *                        selector and lands on its workspace. See
 *                        `app/(dashboard)/create/page.tsx` and
 *                        `lib/navigation/nav-active.ts` for why the two need a
 *                        deliberate active-state rule rather than a prefix
 *                        match.
 *
 * The href stays `/create` rather than a company-specific URL because this is
 * a client component with no session or cookie access — the active company can
 * only be resolved server-side, which is exactly what the shim does.
 */
export function Navigation({ isGlobalAdmin }: Props) {
  const t = useTranslations("navigation");

  const NAV_ITEMS = [
    { label: t("dashboard"), href: "/dashboard", icon: LayoutDashboard },
    { label: t("companies"), href: COMPANIES_HREF, icon: Building2 },
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
