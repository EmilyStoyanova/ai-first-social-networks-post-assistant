import { getTranslations } from "next-intl/server";
import type { CompanyDetails } from "@/lib/services/company/get-company.service";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";

interface Props {
  company: CompanyDetails;
}

export async function CompanyOverview({ company }: Props) {
  const t = await getTranslations("overview");
  const locale = typeof navigator !== "undefined" ? undefined : "en-GB";

  const formattedDate = company.createdAt.toLocaleDateString(locale ?? "en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return (
    <Card className="px-6 py-6">
      <h2 className="text-fg-faint mb-5 text-xs font-semibold tracking-widest uppercase">
        {t("title")}
      </h2>
      <dl className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <dt className="text-fg-faint text-xs font-medium tracking-wide uppercase">{t("name")}</dt>
          <dd className="text-fg mt-1.5 text-sm font-semibold">{company.name}</dd>
        </div>

        <div>
          <dt className="text-fg-faint text-xs font-medium tracking-wide uppercase">{t("slug")}</dt>
          <dd className="text-fg-muted mt-1.5 font-mono text-sm">{company.slug}</dd>
        </div>

        <div>
          <dt className="text-fg-faint text-xs font-medium tracking-wide uppercase">
            {t("website")}
          </dt>
          <dd className="mt-1.5">
            {company.website ? (
              <a
                href={company.website}
                target="_blank"
                rel="noopener noreferrer"
                className="text-status-success-fg hover:text-status-success-fg text-sm transition-colors hover:underline"
              >
                {company.website}
              </a>
            ) : (
              <span className="text-fg-faint text-sm">{t("noWebsite")}</span>
            )}
          </dd>
        </div>

        <div>
          <dt className="text-fg-faint text-xs font-medium tracking-wide uppercase">{t("role")}</dt>
          <dd className="mt-1.5">
            {company.role && (
              <Badge variant={company.role === "OWNER" ? "owner" : "editor"}>{company.role}</Badge>
            )}
          </dd>
        </div>

        <div>
          <dt className="text-fg-faint text-xs font-medium tracking-wide uppercase">
            {t("created")}
          </dt>
          <dd className="text-fg-muted mt-1.5 text-sm">{formattedDate}</dd>
        </div>
      </dl>
    </Card>
  );
}
