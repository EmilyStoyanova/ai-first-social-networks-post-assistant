"use client";

import Link from "next/link";
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
  if (companies.length === 0) {
    return (
      <EmptyState
        title="No companies yet."
        action={<Button href="/companies/new">Create your first company</Button>}
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
              className="absolute inset-0 rounded-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2"
              aria-label={`Open ${company.name}`}
            />
            <Card variant="hover" className="px-6 py-5 hover:border-green-300">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="truncate text-base font-semibold text-gray-900">{company.name}</p>
                  {company.website && (
                    <a
                      href={company.website}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="relative z-10 mt-0.5 block truncate text-sm text-green-600 hover:underline"
                    >
                      {company.website}
                    </a>
                  )}
                  <p className="mt-1 font-mono text-xs text-gray-400">{company.slug}</p>
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
