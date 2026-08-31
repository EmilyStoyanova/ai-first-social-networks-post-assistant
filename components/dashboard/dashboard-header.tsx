"use client";

import { Fragment } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Menu, X } from "lucide-react";
import { Navigation } from "./navigation";
import { NavigationItem } from "./navigation-item";
import { CompanySelector, type ActiveCompanySummary } from "./company-selector";
import { LogoutButton } from "./logout-button";
import { LanguageSwitcher } from "@/components/ui/LanguageSwitcher";
import { Logo } from "@/components/ui/Logo";
import type { BreadcrumbItem } from "./dashboard-layout";

interface SessionUser {
  name?: string | null;
  email?: string | null;
  isGlobalAdmin?: boolean;
}

interface Props {
  user: SessionUser;
  activeCompany: ActiveCompanySummary | null;
  isMobileNavOpen: boolean;
  onToggleMobileNav: () => void;
  breadcrumb?: BreadcrumbItem[];
}

/**
 * The one global horizontal bar (§ Part 1) — logo, the task-oriented nav
 * (Navigation), and the right-hand cluster (company selector, language, user,
 * logout). Replaces the old Sidebar + thin breadcrumb header pair.
 */
export function DashboardHeader({
  user,
  activeCompany,
  isMobileNavOpen,
  onToggleMobileNav,
  breadcrumb,
}: Props) {
  const t = useTranslations();
  const displayName = user.name ?? user.email ?? t("header.userFallback");
  const isGlobalAdmin = user.isGlobalAdmin ?? false;

  return (
    <header className="border-border bg-surface shrink-0 border-b">
      <div className="flex h-14 items-center gap-4 px-4 sm:px-6">
        {/* Hamburger — mobile only */}
        <button
          type="button"
          onClick={onToggleMobileNav}
          aria-label={t("header.openMenu")}
          aria-expanded={isMobileNavOpen}
          className="text-fg-muted hover:bg-surface-subtle hover:text-fg rounded-md p-1.5 lg:hidden"
        >
          {isMobileNavOpen ? (
            <X className="h-5 w-5" aria-hidden="true" />
          ) : (
            <Menu className="h-5 w-5" aria-hidden="true" />
          )}
        </button>

        {/* Logo */}
        <Link href="/dashboard" className="hidden shrink-0 items-center gap-2 lg:flex">
          <Logo size="sm" />
          <span className="text-fg text-sm font-bold tracking-tight">{t("header.logoName")}</span>
        </Link>

        {/* Global nav — desktop only, mobile gets its own list below */}
        <div className="hidden lg:block">
          <Navigation isGlobalAdmin={isGlobalAdmin} />
        </div>

        {/* Breadcrumb, when the page supplies one */}
        <div className="flex min-w-0 flex-1 items-center">
          {breadcrumb && breadcrumb.length > 0 && (
            <nav
              aria-label={t("header.breadcrumb")}
              className="hidden min-w-0 items-center gap-1.5 lg:flex"
            >
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
          )}
        </div>

        {/* Right cluster */}
        <div className="flex shrink-0 items-center gap-3">
          <div className="hidden sm:block">
            <CompanySelector activeCompany={activeCompany} />
          </div>
          <LanguageSwitcher />
          <span className="text-fg-muted hidden text-sm md:block">{displayName}</span>
          <LogoutButton />
        </div>
      </div>

      {/* Mobile nav — an inline disclosure panel, not the old drawer/overlay.
          Carries the same links as the desktop bar, plus the company selector
          (hidden above the `sm` breakpoint in the row above). */}
      {isMobileNavOpen && (
        <div className="border-border bg-surface border-t lg:hidden">
          <nav aria-label={t("navigation.mainNavigation")} className="space-y-0.5 px-3 py-3">
            <NavigationItem
              href="/dashboard"
              label={t("navigation.dashboard")}
              variant="vertical"
            />
            <NavigationItem
              href="/create"
              label={t("navigation.contentCreation")}
              variant="vertical"
            />
            <NavigationItem
              href="/competitive-analysis"
              label={t("navigation.competitiveAnalysis")}
              variant="vertical"
            />
            {isGlobalAdmin && (
              <NavigationItem href="/admin" label={t("navigation.adminPanel")} variant="vertical" />
            )}
          </nav>
          <div className="border-border border-t px-3 py-3 sm:hidden">
            <CompanySelector activeCompany={activeCompany} />
          </div>
        </div>
      )}
    </header>
  );
}
