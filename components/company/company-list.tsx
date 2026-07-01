"use client";

import Link from "next/link";
import type { CompanyListItem } from "@/lib/services/company/list-companies.service";

interface Props {
  companies: CompanyListItem[];
}

function RoleBadge({ role }: { role: CompanyListItem["role"] }) {
  if (role === "OWNER") {
    return (
      <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-semibold text-blue-700">
        OWNER
      </span>
    );
  }
  if (role === "EDITOR") {
    return (
      <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-semibold text-gray-600">
        EDITOR
      </span>
    );
  }
  return null;
}

export function CompanyList({ companies }: Props) {
  if (companies.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-gray-300 bg-white px-8 py-16 text-center">
        <p className="text-sm font-medium text-gray-500">No companies yet.</p>
        <Link
          href="/companies/new"
          className="mt-4 inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
        >
          Create your first company
        </Link>
      </div>
    );
  }

  return (
    <ul className="space-y-3">
      {companies.map((company) => (
        <li
          key={company.id}
          className="rounded-2xl border border-gray-200 bg-white px-6 py-5 shadow-sm"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="truncate text-base font-semibold text-gray-900">{company.name}</p>
              {company.website && (
                <a
                  href={company.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-0.5 block truncate text-sm text-blue-600 hover:underline"
                >
                  {company.website}
                </a>
              )}
              <p className="mt-1 font-mono text-xs text-gray-400">{company.slug}</p>
            </div>
            <div className="shrink-0 pt-0.5">
              <RoleBadge role={company.role} />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
