import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/lib/auth";
import { getCompany } from "@/lib/services/company/get-company.service";
import { DashboardLayout } from "@/components/dashboard/dashboard-layout";
import { CompetitiveAnalysisHeader } from "@/components/competitive-analysis/analysis-header";
import { Card } from "@/components/ui/Card";

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Content – Competitive Analysis – ${slug} – AI-First Post Assistant` };
}

/**
 * Placeholder foundation only (§12 of the Part 3A task). The read API
 * (`list-competitor-content.service.ts`), competitor content collection, and
 * structured analysis are all Part 3B — nothing here is faked.
 */
export default async function CompetitiveAnalysisContentPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const { slug } = await params;
  const company = await getCompany(slug, session.user.id, session.user.isGlobalAdmin);
  if (!company) notFound();

  const t = await getTranslations("competitiveAnalysis.content");

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
        <CompetitiveAnalysisHeader slug={slug} activeTab="content" />
        <Card className="px-6 py-14 text-center">
          <p className="text-body text-fg-muted">{t("comingSoon")}</p>
        </Card>
      </div>
    </DashboardLayout>
  );
}
