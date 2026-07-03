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
  const displayName = user.name ?? user.email ?? "User";

  const PAGE_TITLES: Record<string, string> = {
    "/dashboard": t("navigation.dashboard"),
    "/companies": t("navigation.companies"),
    "/companies/new": t("createCompany.title"),
  };

  const fallbackTitle =
    PAGE_TITLES[pathname] ?? (pathname.startsWith("/companies/") ? t("navigation.companies") : "");

  return (
    <header className="flex h-16 shrink-0 items-center gap-4 border-b border-gray-200 bg-white px-4 sm:px-6">
      {/* Hamburger — mobile only */}
      <button
        type="button"
        onClick={onMenuClick}
        aria-label={t("header.openMenu")}
        className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900 lg:hidden"
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
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
            {breadcrumb.map((item, i) => (
              <Fragment key={item.label}>
                {i > 0 && (
                  <span className="shrink-0 text-sm text-gray-300" aria-hidden="true">
                    /
                  </span>
                )}
                {item.href ? (
                  <Link
                    href={item.href}
                    className="shrink-0 text-sm text-gray-500 transition-colors hover:text-gray-900"
                  >
                    {item.label}
                  </Link>
                ) : (
                  <span
                    className="truncate text-sm font-semibold text-gray-900"
                    aria-current="page"
                  >
                    {item.label}
                  </span>
                )}
              </Fragment>
            ))}
          </nav>
        ) : (
          <h1 className="text-lg font-semibold text-gray-900">{fallbackTitle}</h1>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-4">
        <LanguageSwitcher />
        <span className="hidden text-sm text-gray-600 sm:block">{displayName}</span>
        <LogoutButton />
      </div>
    </header>
  );
}
