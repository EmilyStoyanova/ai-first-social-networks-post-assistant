"use client";

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

function roleBadgeVariant(role: CompanyListItem["role"]) {
  if (role === "OWNER") return "owner" as const;
  if (role === "EDITOR") return "editor" as const;
  return null;
}

export function CompanyList({ companies }: Props) {
  const t = useTranslations("companies");

  if (companies.length === 0) {
    return (
      <EmptyState
        title={t("noCompanies")}
        action={<Button href="/companies/new">{t("createFirst")}</Button>}
      />
    );
  }

  return (
    <ul className="space-y-3">
      {companies.map((company) => {
        const badge = roleBadgeVariant(company.role);
        return (
          <li key={company.id} className="relative cursor-pointer">
            {/* Stretched link — makes the whole card navigate to the detail page. */}
            <Link
              href={`/companies/${company.slug}`}
              className="rounded-card focus-visible:ring-accent absolute inset-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
              aria-label={`Open ${company.name}`}
            />
            <Card variant="hover" className="px-6 py-5 hover:border-green-300">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-fg truncate text-base font-semibold">{company.name}</p>
                  {company.website && (
                    <a
                      href={company.website}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-status-success-fg relative z-10 mt-0.5 block truncate text-sm hover:underline"
                    >
                      {company.website}
                    </a>
                  )}
                  <p className="text-fg-faint mt-1 font-mono text-xs">{company.slug}</p>
                </div>
                {badge && (
                  <div className="relative z-10 shrink-0 pt-0.5">
                    <Badge variant={badge}>{company.role}</Badge>
                  </div>
                )}
              </div>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
