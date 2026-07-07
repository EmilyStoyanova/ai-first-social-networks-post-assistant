"use client";

import { LayoutDashboard, Building2, ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { NavigationItem } from "./navigation-item";

interface Props {
  isGlobalAdmin: boolean;
}

export function Navigation({ isGlobalAdmin }: Props) {
  const t = useTranslations("navigation");

  const NAV_ITEMS = [
    { label: t("dashboard"), href: "/dashboard", icon: LayoutDashboard },
    { label: t("companies"), href: "/companies", icon: Building2 },
  ];

  return (
    <nav aria-label={t("mainNavigation")} className="space-y-3">
      <ul role="list" className="space-y-0.5">
        {NAV_ITEMS.map((item) => (
          <li key={item.href}>
            <NavigationItem href={item.href} label={item.label} icon={item.icon} />
          </li>
        ))}
      </ul>

      {isGlobalAdmin && (
        <div className="border-border border-t pt-3">
          <p className="text-micro text-fg-faint mb-1 px-3">{t("admin")}</p>
          <ul role="list" className="space-y-0.5">
            <li>
              <NavigationItem href="/admin" label={t("adminPanel")} icon={ShieldCheck} />
            </li>
          </ul>
        </div>
      )}
    </nav>
  );
}
