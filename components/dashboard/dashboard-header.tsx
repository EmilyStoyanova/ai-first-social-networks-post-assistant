"use client";

import { Fragment } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Menu, X } from "lucide-react";
import { Navigation } from "./navigation";
import { NavigationItem } from "./navigation-item";
import { CompanySelector, type ActiveCompanySummary } from "./company-selector";
import { UserMenu } from "./user-menu";
import { COMPANIES_HREF, COMPANY_MANAGEMENT_HREF } from "@/lib/navigation/nav-active";
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
 * The one global horizontal bar (§ Part 1) — logo, the nav, and a right-hand
 * cluster that is now just two controls: the company selector and the account
 * menu. The user's name, the EN/BG switcher and the Logout button used to sit
 * there as three separate permanent items; they all live inside `UserMenu`
 * now, which is the same three controls behind one 32px avatar.
 */
export function DashboardHeader({
  user,
  activeCompany,
  isMobileNavOpen,
  onToggleMobileNav,
  breadcrumb,
}: Props) {
  const t = useTranslations();
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

        {/* Right cluster — two controls, both compact. */}
        <div className="flex shrink-0 items-center gap-2">
          <div className="hidden sm:block">
            <CompanySelector activeCompany={activeCompany} />
          </div>
          <UserMenu name={user.name} email={user.email} />
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
              href={COMPANIES_HREF}
              label={t("navigation.companies")}
              variant="vertical"
            />
            <NavigationItem
              href={COMPANY_MANAGEMENT_HREF}
              label={t("navigation.companyManagement")}
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
