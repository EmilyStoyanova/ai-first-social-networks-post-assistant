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
  title: "Content Creation – AI-First Post Assistant",
};

/**
 * Global landing for the Content Creation module. Never shows a
 * company-picker when an active company is already known — it redirects
 * straight to `/create/[slug]`. `resolveActiveCompany`'s own fallback already
 * tries "first accessible company" before giving up, so reaching the empty
 * state below means the user truly has no company yet, not that a choice is
 * needed.
 */
export default async function ContentCreationLandingPage() {
  const session = await auth();
  if (!session) redirect("/login");

  const cookieSlug = (await cookies()).get("active_company")?.value ?? null;
  const activeCompany = await resolveActiveCompany({
    cookieSlug,
    userId: session.user.id,
    isGlobalAdmin: session.user.isGlobalAdmin,
  });

  if (activeCompany) redirect(`/create/${activeCompany.slug}`);

  const t = await getTranslations("contentCreation");

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
