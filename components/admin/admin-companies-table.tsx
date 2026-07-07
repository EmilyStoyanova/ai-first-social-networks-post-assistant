import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Building2 } from "lucide-react";
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
    return <EmptyState icon={<Building2 className="h-5 w-5" />} title={t("noCompanies")} />;
  }

  return (
    <Card className="overflow-hidden px-0 py-0">
      {/* Desktop header */}
      <div className="border-border bg-surface-subtle hidden grid-cols-[minmax(0,1fr)_8rem_minmax(0,1fr)_4rem_minmax(0,1fr)_7rem] gap-4 border-b px-6 py-3 sm:grid">
        <span className="text-micro text-fg-faint">{t("companies")}</span>
        <span className="text-micro text-fg-faint">{t("slug")}</span>
        <span className="text-micro text-fg-faint">{t("website")}</span>
        <span className="text-micro text-fg-faint text-center">{t("membersCol")}</span>
        <span className="text-micro text-fg-faint">{t("owners")}</span>
        <span className="text-micro text-fg-faint">{t("created")}</span>
      </div>

      <div className="divide-border divide-y">
        {companies.map((c) => (
          <div key={c.id} className="px-6 py-4">
            {/* Mobile: stacked */}
            <div className="sm:hidden">
              <Link
                href={`/companies/${c.slug}`}
                className="text-accent text-sm font-semibold hover:underline"
              >
                {c.name}
              </Link>
              <p className="text-fg-faint mt-0.5 text-xs">{c.slug}</p>
              {c.website && <p className="text-fg-faint mt-0.5 truncate text-xs">{c.website}</p>}
              <p className="text-fg-faint mt-1 text-xs">
                {t("memberCount", { count: c.memberCount })} &middot; {fmtDate(c.createdAt)}
              </p>
              {c.ownerEmails.length > 0 && (
                <p className="text-fg-faint mt-0.5 text-xs">
                  {t("owners")}: {c.ownerEmails.join(", ")}
                </p>
              )}
            </div>

            {/* Desktop: grid */}
            <div className="hidden grid-cols-[minmax(0,1fr)_8rem_minmax(0,1fr)_4rem_minmax(0,1fr)_7rem] items-center gap-4 sm:grid">
              <div className="min-w-0">
                <Link
                  href={`/companies/${c.slug}`}
                  className="text-accent block truncate text-sm font-semibold hover:underline"
                >
                  {c.name}
                </Link>
              </div>
              <div className="min-w-0">
                <p className="text-fg-muted truncate text-xs">{c.slug}</p>
              </div>
              <div className="min-w-0">
                {c.website ? (
                  <p className="text-fg-muted truncate text-xs">{c.website}</p>
                ) : (
                  <span className="text-fg-faint text-xs">—</span>
                )}
              </div>
              <div className="text-fg-muted text-center text-sm">{c.memberCount}</div>
              <div className="min-w-0">
                {c.ownerEmails.length > 0 ? (
                  <p className="text-fg-muted truncate text-xs">{c.ownerEmails.join(", ")}</p>
                ) : (
                  <span className="text-fg-faint text-xs">—</span>
                )}
              </div>
              <div className="text-fg-muted text-xs">{fmtDate(c.createdAt)}</div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
