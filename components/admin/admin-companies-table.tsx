import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import type { AdminCompanyItem } from "@/lib/services/admin/list-companies.service";

function fmtDate(d: Date) {
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

interface Props {
  companies: AdminCompanyItem[];
}

export async function AdminCompaniesTable({ companies }: Props) {
  const t = await getTranslations("admin");

  if (companies.length === 0) {
    return <EmptyState icon="🏢" title={t("noCompanies")} />;
  }

  return (
    <Card className="overflow-hidden px-0 py-0">
      {/* Desktop header */}
      <div className="hidden grid-cols-[minmax(0,1fr)_8rem_minmax(0,1fr)_4rem_minmax(0,1fr)_7rem] gap-4 border-b border-gray-100 bg-gray-50 px-6 py-3 sm:grid">
        <span className="text-xs font-medium tracking-wide text-gray-400 uppercase">
          {t("companies")}
        </span>
        <span className="text-xs font-medium tracking-wide text-gray-400 uppercase">
          {t("slug")}
        </span>
        <span className="text-xs font-medium tracking-wide text-gray-400 uppercase">
          {t("website")}
        </span>
        <span className="text-center text-xs font-medium tracking-wide text-gray-400 uppercase">
          {t("membersCol")}
        </span>
        <span className="text-xs font-medium tracking-wide text-gray-400 uppercase">
          {t("owners")}
        </span>
        <span className="text-xs font-medium tracking-wide text-gray-400 uppercase">
          {t("created")}
        </span>
      </div>

      <div className="divide-y divide-gray-100">
        {companies.map((c) => (
          <div key={c.id} className="px-6 py-4">
            {/* Mobile: stacked */}
            <div className="sm:hidden">
              <Link
                href={`/companies/${c.slug}`}
                className="text-sm font-semibold text-green-700 hover:underline"
              >
                {c.name}
              </Link>
              <p className="mt-0.5 text-xs text-gray-400">{c.slug}</p>
              {c.website && <p className="mt-0.5 truncate text-xs text-gray-400">{c.website}</p>}
              <p className="mt-1 text-xs text-gray-400">
                {t("memberCount", { count: c.memberCount })} &middot; {fmtDate(c.createdAt)}
              </p>
              {c.ownerEmails.length > 0 && (
                <p className="mt-0.5 text-xs text-gray-400">
                  {t("owners")}: {c.ownerEmails.join(", ")}
                </p>
              )}
            </div>

            {/* Desktop: grid */}
            <div className="hidden grid-cols-[minmax(0,1fr)_8rem_minmax(0,1fr)_4rem_minmax(0,1fr)_7rem] items-center gap-4 sm:grid">
              <div className="min-w-0">
                <Link
                  href={`/companies/${c.slug}`}
                  className="block truncate text-sm font-semibold text-green-700 hover:underline"
                >
                  {c.name}
                </Link>
              </div>
              <div className="min-w-0">
                <p className="truncate text-xs text-gray-500">{c.slug}</p>
              </div>
              <div className="min-w-0">
                {c.website ? (
                  <p className="truncate text-xs text-gray-500">{c.website}</p>
                ) : (
                  <span className="text-xs text-gray-300">—</span>
                )}
              </div>
              <div className="text-center text-sm text-gray-600">{c.memberCount}</div>
              <div className="min-w-0">
                {c.ownerEmails.length > 0 ? (
                  <p className="truncate text-xs text-gray-500">{c.ownerEmails.join(", ")}</p>
                ) : (
                  <span className="text-xs text-gray-300">—</span>
                )}
              </div>
              <div className="text-xs text-gray-500">{fmtDate(c.createdAt)}</div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
