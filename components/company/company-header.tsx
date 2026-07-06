import { getTranslations } from "next-intl/server";
import type { CompanyDetails } from "@/lib/services/company/get-company.service";
import { Badge } from "@/components/ui/Badge";

interface Props {
  company: CompanyDetails;
}

export async function CompanyHeader({ company }: Props) {
  const t = await getTranslations("overview");

  return (
    <div className="flex items-start justify-between gap-6">
      <div className="min-w-0">
        <h1 className="text-fg text-3xl font-bold tracking-tight">{company.name}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          {company.website ? (
            <a
              href={company.website}
              target="_blank"
              rel="noopener noreferrer"
              className="text-status-success-fg hover:text-status-success-fg inline-flex items-center gap-1 text-sm transition-colors hover:underline"
            >
              {company.website}
              <svg
                className="h-3 w-3 shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                />
              </svg>
            </a>
          ) : (
            <span className="text-fg-faint text-sm">{t("noWebsite")}</span>
          )}
          <span className="text-border" aria-hidden="true">
            |
          </span>
          <span className="text-fg-faint font-mono text-xs">{company.slug}</span>
        </div>
      </div>

      {company.role && (
        <div className="shrink-0 pt-1">
          <Badge variant={company.role === "OWNER" ? "owner" : "editor"} className="px-3 py-1">
            {company.role}
          </Badge>
        </div>
      )}
    </div>
  );
}
