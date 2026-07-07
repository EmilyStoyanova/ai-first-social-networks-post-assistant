"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { CompanyListItem } from "@/lib/services/company/list-companies.service";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";

interface Props {
  companies: CompanyListItem[];
}

type RoleFilter = "ALL" | "OWNER" | "EDITOR";

function roleBadgeVariant(role: CompanyListItem["role"]) {
  if (role === "OWNER") return "owner" as const;
  if (role === "EDITOR") return "editor" as const;
  return null;
}

export function CompanyCards({ companies }: Props) {
  const t = useTranslations("companies");
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("ALL");

  if (companies.length === 0) {
    return (
      <EmptyState
        title={t("noCompanies")}
        action={<Button href="/companies/new">{t("createFirst")}</Button>}
      />
    );
  }

  const filtered = companies.filter((c) => {
    const q = search.toLowerCase();
    const matchesSearch =
      !search || c.name.toLowerCase().includes(q) || c.slug.toLowerCase().includes(q);
    const matchesRole = roleFilter === "ALL" || c.role === roleFilter;
    return matchesSearch && matchesRole;
  });

  const ROLE_TABS: { value: RoleFilter; label: string }[] = [
    { value: "ALL", label: t("allRoles") },
    { value: "OWNER", label: t("owner") },
    { value: "EDITOR", label: t("editor") },
  ];

  return (
    <div className="space-y-4">
      {/* Search + role filter */}
      <div className="flex gap-3">
        <input
          type="text"
          placeholder={t("searchPlaceholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="rounded-control border-border bg-surface text-fg focus-visible:outline-accent placeholder:text-fg-faint min-w-0 flex-1 border px-3.5 py-2 text-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-0"
        />
        <div className="rounded-control border-border-strong flex shrink-0 overflow-hidden border">
          {ROLE_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              onClick={() => setRoleFilter(tab.value)}
              className={[
                "px-3 py-2 text-xs font-medium transition-colors",
                roleFilter === tab.value
                  ? "bg-fg text-bg"
                  : "bg-surface text-fg-muted hover:bg-surface-subtle",
              ].join(" ")}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="text-fg-faint py-10 text-center text-sm">{t("noResults")}</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((company) => {
            const badge = roleBadgeVariant(company.role);
            return (
              <div key={company.id} className="relative">
                {/* Stretched link covers the whole card */}
                <Link
                  href={`/companies/${company.slug}`}
                  className="focus-visible:ring-accent rounded-card absolute inset-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
                  aria-label={`Open ${company.name}`}
                />
                <Card variant="hover" className="flex h-full flex-col px-5 py-5">
                  {/* Company name + role badge */}
                  <div className="mb-3 flex items-start justify-between gap-2">
                    <p className="text-fg text-sm leading-snug font-semibold">{company.name}</p>
                    {badge && <Badge variant={badge}>{company.role}</Badge>}
                  </div>

                  {/* Post status chips */}
                  <div className="mb-4 flex flex-wrap gap-1.5">
                    {company.pendingCount > 0 && (
                      <span className="text-micro bg-status-warning-bg text-status-warning-fg inline-flex h-[22px] items-center rounded-full px-2.5">
                        {t("pendingApprovals", { count: company.pendingCount })}
                      </span>
                    )}
                    {company.draftCount > 0 && (
                      <span className="text-micro bg-status-neutral-bg text-status-neutral-fg inline-flex h-[22px] items-center rounded-full px-2.5">
                        {t("drafts", { count: company.draftCount })}
                      </span>
                    )}
                    {company.pendingCount === 0 && company.draftCount === 0 && (
                      <span className="text-fg-faint text-xs">—</span>
                    )}
                  </div>

                  {/* Slug + website */}
                  <div className="mt-auto">
                    <p className="text-fg-faint font-mono text-xs">{company.slug}</p>
                    {company.website && (
                      <p className="text-fg-faint mt-0.5 truncate text-xs">{company.website}</p>
                    )}
                  </div>
                </Card>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
