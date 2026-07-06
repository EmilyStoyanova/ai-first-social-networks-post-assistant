"use client";

import { Fragment } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { LogoutButton } from "./logout-button";
import { LanguageSwitcher } from "@/components/ui/LanguageSwitcher";
import type { BreadcrumbItem } from "./dashboard-layout";

interface SessionUser {
  name?: string | null;
  email?: string | null;
}

interface Props {
  user: SessionUser;
  onMenuClick: () => void;
  breadcrumb?: BreadcrumbItem[];
}

export function DashboardHeader({ user, onMenuClick, breadcrumb }: Props) {
  const pathname = usePathname();
  const t = useTranslations();
  const displayName = user.name ?? user.email ?? t("header.userFallback");

  const PAGE_TITLES: Record<string, string> = {
    "/dashboard": t("navigation.dashboard"),
    "/companies": t("navigation.companies"),
    "/companies/new": t("createCompany.title"),
  };

  const fallbackTitle =
    PAGE_TITLES[pathname] ?? (pathname.startsWith("/companies/") ? t("navigation.companies") : "");

  return (
    <header className="border-border bg-surface flex h-16 shrink-0 items-center gap-4 border-b px-4 sm:px-6">
      {/* Hamburger — mobile only */}
      <button
        type="button"
        onClick={onMenuClick}
        aria-label={t("header.openMenu")}
        className="text-fg-muted hover:bg-surface-subtle hover:text-fg rounded-md p-1.5 lg:hidden"
      >
        <svg
          className="h-5 w-5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      {/* Title / breadcrumb */}
      <div className="flex min-w-0 flex-1 items-center">
        {breadcrumb && breadcrumb.length > 0 ? (
          <nav aria-label={t("header.breadcrumb")} className="flex min-w-0 items-center gap-1.5">
            {breadcrumb.map((item, i) => (
              <Fragment key={item.label}>
                {i > 0 && (
                  <span className="text-fg-faint shrink-0 text-sm" aria-hidden="true">
                    /
                  </span>
                )}
                {item.href ? (
                  <Link
                    href={item.href}
                    className="text-fg-muted hover:text-fg shrink-0 text-sm transition-colors"
                  >
                    {item.label}
                  </Link>
                ) : (
                  <span className="text-fg truncate text-sm font-semibold" aria-current="page">
                    {item.label}
                  </span>
                )}
              </Fragment>
            ))}
          </nav>
        ) : (
          <h1 className="text-fg text-lg font-semibold">{fallbackTitle}</h1>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-4">
        <LanguageSwitcher />
        <span className="text-fg-muted hidden text-sm sm:block">{displayName}</span>
        <LogoutButton />
      </div>
    </header>
  );
}
