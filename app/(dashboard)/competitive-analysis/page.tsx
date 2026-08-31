import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import { auth } from "@/lib/auth";
import { resolveActiveCompany } from "@/lib/services/company/resolve-active-company.service";
import { DashboardLayout } from "@/components/dashboard/dashboard-layout";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/Button";

export const metadata: Metadata = {
  title: "Competitive Analysis – AI-First Post Assistant",
};

/**
 * Global landing for the Competitive Analysis module — mirrors
 * `/create/page.tsx` exactly (see its comment for why there is no
 * multi-company picker branch).
 */
export default async function CompetitiveAnalysisLandingPage() {
  const session = await auth();
  if (!session) redirect("/login");

  const cookieSlug = (await cookies()).get("active_company")?.value ?? null;
  const activeCompany = await resolveActiveCompany({
    cookieSlug,
    userId: session.user.id,
    isGlobalAdmin: session.user.isGlobalAdmin,
  });

  if (activeCompany) redirect(`/competitive-analysis/${activeCompany.slug}`);

  const t = await getTranslations("competitiveAnalysis");

  return (
    <DashboardLayout
      user={{
        name: session.user.name,
        email: session.user.email,
        isGlobalAdmin: session.user.isGlobalAdmin,
      }}
    >
      <EmptyState
        title={t("noCompaniesTitle")}
        description={t("noCompaniesDesc")}
        action={<Button href="/companies/new">{t("createCompany")}</Button>}
      />
    </DashboardLayout>
  );
}
