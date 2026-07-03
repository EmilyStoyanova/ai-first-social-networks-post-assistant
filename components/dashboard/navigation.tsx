"use client";

import { useTranslations } from "next-intl";
import { NavigationItem } from "./navigation-item";

interface Props {
  isGlobalAdmin: boolean;
}

export function Navigation({ isGlobalAdmin }: Props) {
  const t = useTranslations("navigation");

  const NAV_ITEMS = [
    { label: t("dashboard"), href: "/dashboard" },
    { label: t("companies"), href: "/companies" },
    { label: t("posts"), href: "/posts", disabled: true },
    { label: t("mediaGallery"), href: "/media", disabled: true },
    { label: t("analytics"), href: "/analytics", disabled: true },
    { label: t("settings"), href: "/settings", disabled: true },
  ];

  return (
    <nav aria-label={t("mainNavigation")} className="space-y-4">
      <ul role="list" className="space-y-1">
        {NAV_ITEMS.map((item) => (
          <li key={item.href}>
            <NavigationItem href={item.href} label={item.label} disabled={item.disabled} />
          </li>
        ))}
      </ul>

      {isGlobalAdmin && (
        <div className="border-t border-gray-100 pt-4">
          <p className="mb-1 px-3 text-xs font-semibold tracking-widest text-gray-400 uppercase">
            {t("admin")}
          </p>
          <ul role="list" className="space-y-1">
            <li>
              <NavigationItem href="/admin" label={t("adminPanel")} />
            </li>
          </ul>
        </div>
      )}
    </nav>
  );
}
