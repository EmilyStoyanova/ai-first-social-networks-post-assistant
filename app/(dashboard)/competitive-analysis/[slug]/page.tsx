import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/lib/auth";
import { getCompany } from "@/lib/services/company/get-company.service";
import { DashboardLayout } from "@/components/dashboard/dashboard-layout";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Competitive Analysis – ${slug} – AI-First Post Assistant` };
}

/**
 * The Competitive Analysis module for one company (its own route root).
 * Placeholder for Part 1 only — the Overview/Competitors/Content/Trends
 * sub-tabs, the data model, and every service are Part 3's job.
 */
export default async function CompetitiveAnalysisPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const { slug } = await params;
  const company = await getCompany(slug, session.user.id, session.user.isGlobalAdmin);
  if (!company) notFound();

  const t = await getTranslations("competitiveAnalysis");

  return (
    <DashboardLayout
      user={{
        name: session.user.name,
        email: session.user.email,
        isGlobalAdmin: session.user.isGlobalAdmin,
      }}
      activeCompany={{ slug: company.slug, name: company.name }}
    >
      <div className="space-y-6">
        <PageHeader
          title={t("title")}
          description={t("placeholderDescription", { company: company.name })}
        />
        <Card className="px-6 py-14 text-center">
          <p className="text-body text-fg-muted">{t("comingSoon")}</p>
        </Card>
      </div>
    </DashboardLayout>
  );
}
