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
      <h2 className="mb-5 text-xs font-semibold tracking-widest text-gray-400 uppercase">
        {t("title")}
      </h2>
      <dl className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <dt className="text-xs font-medium tracking-wide text-gray-400 uppercase">{t("name")}</dt>
          <dd className="mt-1.5 text-sm font-semibold text-gray-900">{company.name}</dd>
        </div>

        <div>
          <dt className="text-xs font-medium tracking-wide text-gray-400 uppercase">{t("slug")}</dt>
          <dd className="mt-1.5 font-mono text-sm text-gray-700">{company.slug}</dd>
        </div>

        <div>
          <dt className="text-xs font-medium tracking-wide text-gray-400 uppercase">
            {t("website")}
          </dt>
          <dd className="mt-1.5">
            {company.website ? (
              <a
                href={company.website}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-green-600 transition-colors hover:text-green-700 hover:underline"
              >
                {company.website}
              </a>
            ) : (
              <span className="text-sm text-gray-400">{t("noWebsite")}</span>
            )}
          </dd>
        </div>

        <div>
          <dt className="text-xs font-medium tracking-wide text-gray-400 uppercase">{t("role")}</dt>
          <dd className="mt-1.5">
            {company.role && (
              <Badge variant={company.role === "OWNER" ? "owner" : "editor"}>{company.role}</Badge>
            )}
          </dd>
        </div>

        <div>
          <dt className="text-xs font-medium tracking-wide text-gray-400 uppercase">
            {t("created")}
          </dt>
          <dd className="mt-1.5 text-sm text-gray-700">{formattedDate}</dd>
        </div>
      </dl>
    </Card>
  );
}
