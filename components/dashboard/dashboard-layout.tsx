"use client";

import { useCallback, useState } from "react";
import { DashboardHeader } from "./dashboard-header";
import type { ActiveCompanySummary } from "./company-selector";

interface SessionUser {
  name?: string | null;
  email?: string | null;
  isGlobalAdmin?: boolean;
}

export type BreadcrumbItem = { label: string; href?: string };

interface Props {
  user: SessionUser;
  children: React.ReactNode;
  breadcrumb?: BreadcrumbItem[];
  /**
   * The company this page resolved as active, for the header's selector.
   * A page that already fetches its own company (every `/companies/[slug]/...`
   * page, plus `/create/[slug]` and `/competitive-analysis/[slug]/...`) passes
   * it straight through at zero extra cost. A page with no company in scope
   * (`/dashboard`, `/companies`, `/admin`) calls `resolveActiveCompany` once,
   * display-only. Omitted (or null) renders the selector's "no company" state.
   */
  activeCompany?: ActiveCompanySummary | null;
}

export function DashboardLayout({ user, children, breadcrumb, activeCompany = null }: Props) {
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);

  // Memoised so DashboardHeader doesn't re-render on every DashboardLayout
  // render for a prop that never actually changes identity otherwise.
  const toggleMobileNav = useCallback(() => setIsMobileNavOpen((open) => !open), []);

  return (
    <div className="bg-surface-subtle flex h-screen flex-col overflow-hidden">
      <DashboardHeader
        user={user}
        activeCompany={activeCompany}
        isMobileNavOpen={isMobileNavOpen}
        onToggleMobileNav={toggleMobileNav}
        breadcrumb={breadcrumb}
      />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">{children}</div>
      </main>
    </div>
  );
}
