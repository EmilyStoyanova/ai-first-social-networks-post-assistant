"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Building2, Check, ChevronDown, Plus } from "lucide-react";
import { companySwitchHref } from "@/lib/navigation/company-switch-href";
import type { CompanyListItem } from "@/lib/services/company/list-companies.service";

export interface ActiveCompanySummary {
  slug: string;
  name: string;
}

interface Props {
  /** The company the current page resolved as active, or null (no accessible company). */
  activeCompany: ActiveCompanySummary | null;
}

/**
 * Persistent "Current Company" control in the global header — separate from
 * the main nav, per the approved plan. Switching writes the `active_company`
 * cookie the same way `LanguageSwitcher` writes `NEXT_LOCALE` (a plain
 * `document.cookie` set, the smallest mechanism already used in this repo),
 * then navigates via `companySwitchHref` to preserve the current sub-route
 * where the destination has one, or just refreshes in place (Dashboard/Admin)
 * when it doesn't.
 *
 * ONE responsibility: which company is active. The main nav answers what the
 * user wants to do (Companies, Company Management), so this menu deliberately
 * holds no management links — see the comment above `+ Add company`, the one
 * action that has nowhere else to live.
 */
export function CompanySelector({ activeCompany }: Props) {
  const t = useTranslations("header.companySelector");
  const pathname = usePathname();
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);

  const [isOpen, setIsOpen] = useState(false);
  const [companies, setCompanies] = useState<CompanyListItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingSlug, setPendingSlug] = useState<string | null>(null);

  // Mirrors LanguageSwitcher's `NEXT_LOCALE` pattern: the cookie write (and the
  // navigation it drives) happens in an effect reacting to state, not directly
  // inside the click handler.
  useEffect(() => {
    if (pendingSlug === null) return;
    document.cookie = `active_company=${pendingSlug}; path=/; max-age=31536000; SameSite=Lax`;
    const target = companySwitchHref(pathname, pendingSlug);
    if (target) {
      router.push(target);
    } else {
      // Dashboard/Admin have no company-scoped route to move to — the
      // preference is updated, but their own semantics stay untouched.
      router.refresh();
    }
  }, [pendingSlug, pathname, router]);

  useEffect(() => {
    function onClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    function onEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setIsOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onEscape);
    };
  }, []);

  async function handleToggle() {
    const next = !isOpen;
    setIsOpen(next);
    if (next && companies === null && !loading) {
      setLoading(true);
      try {
        const res = await fetch("/api/v1/companies");
        if (res.ok) setCompanies((await res.json()) as CompanyListItem[]);
      } finally {
        setLoading(false);
      }
    }
  }

  function handleSwitch(slug: string) {
    setIsOpen(false);
    if (slug === activeCompany?.slug) return;
    setPendingSlug(slug);
  }

  const label = activeCompany?.name ?? t("noCompany");

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={handleToggle}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        className="rounded-control border-border-strong hover:bg-surface-subtle duration-fast focus-visible:outline-accent inline-flex items-center gap-1.5 border px-3 py-1.5 text-sm transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <Building2 className="text-fg-faint h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="text-fg-muted hidden sm:inline">{t("label")}:</span>
        <span className="text-fg max-w-[9rem] truncate font-medium">{label}</span>
        <ChevronDown className="text-fg-faint h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      </button>

      {isOpen && (
        <div
          role="menu"
          aria-label={t("label")}
          className="rounded-control border-border bg-surface absolute right-0 z-50 mt-1.5 w-64 border py-1 shadow-lg"
        >
          {loading || companies === null ? (
            <div className="text-fg-faint px-3 py-2 text-sm">{t("loading")}</div>
          ) : companies.length === 0 ? (
            <div className="text-fg-faint px-3 py-2 text-sm">{t("noCompanies")}</div>
          ) : (
            <ul role="list" className="max-h-64 overflow-y-auto">
              {companies.map((c) => {
                const isCurrent = c.slug === activeCompany?.slug;
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => handleSwitch(c.slug)}
                      aria-label={t("switchTo", { name: c.name })}
                      className="hover:bg-surface-subtle duration-fast flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors"
                    >
                      <span className="truncate">{c.name}</span>
                      {isCurrent && (
                        <Check className="text-accent h-4 w-4 shrink-0" aria-hidden="true" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="border-border my-1 border-t" />

          {/* "Manage current company" (→ /companies/[slug]) was removed
              2026-09-02: the main nav already carries that destination as
              Company Management. "Manage companies" (→ /companies), removed
              the same day for the same reason, came back 2026-09-03 once
              Companies itself left the main nav (see `navigation.tsx`) — this
              is now the only way back to the full list (search, role filter,
              per-company draft counts), since the list above is this menu's
              own compact switcher, not that page. */}
          <Link
            href="/companies"
            role="menuitem"
            onClick={() => setIsOpen(false)}
            className="hover:bg-surface-subtle duration-fast flex items-center gap-1.5 px-3 py-2 text-sm transition-colors"
          >
            <Building2 className="h-3.5 w-3.5" aria-hidden="true" />
            {t("viewAllCompanies")}
          </Link>

          {/* No RBAC restriction exists on creating a company today (verified
              against companies/new/page.tsx — any authenticated user may) —
              so this is unconditional, matching that. */}
          <Link
            href="/companies/new"
            role="menuitem"
            onClick={() => setIsOpen(false)}
            className="hover:bg-surface-subtle duration-fast flex items-center gap-1.5 px-3 py-2 text-sm transition-colors"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            {t("addCompany")}
          </Link>
        </div>
      )}
    </div>
  );
}
