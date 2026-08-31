import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import { auth } from "@/lib/auth";
import { listAdminUsers } from "@/lib/services/admin/list-users.service";
import { listAdminCompanies } from "@/lib/services/admin/list-companies.service";
import { listLlmProviders } from "@/lib/services/admin/list-llm-providers.service";
import { resolveActiveCompany } from "@/lib/services/company/resolve-active-company.service";
import { DashboardLayout } from "@/components/dashboard/dashboard-layout";
import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { AdminOverview } from "@/components/admin/admin-overview";
import { AdminUsersTable } from "@/components/admin/admin-users-table";
import { AdminCompaniesTable } from "@/components/admin/admin-companies-table";
import { LlmConfigSection } from "@/components/admin/llm-config-section";

export const metadata: Metadata = {
  title: "Global Admin – AI-First Post Assistant",
};

export default async function AdminPage() {
  const session = await auth();
  if (!session) redirect("/login");
  if (!session.user.isGlobalAdmin) notFound();

  const t = await getTranslations("admin");
  const tNav = await getTranslations("navigation");

  const [usersResult, companiesResult, providersResult] = await Promise.all([
    listAdminUsers(session.user.isGlobalAdmin),
    listAdminCompanies(session.user.isGlobalAdmin),
    listLlmProviders(session.user.isGlobalAdmin),
  ]);

  const users = usersResult.success ? usersResult.users : [];
  const companies = companiesResult.success ? companiesResult.companies : [];
  const adminCount = users.filter((u) => u.isGlobalAdmin).length;

  const providers = providersResult.success ? providersResult.providers : [];

  // Display-only — a global admin may hold no company membership at all, in
  // which case the selector shows its "no company" state; that is expected
  // here, not an error.
  const cookieSlug = (await cookies()).get("active_company")?.value ?? null;
  const activeCompany = await resolveActiveCompany({
    cookieSlug,
    userId: session.user.id,
    isGlobalAdmin: session.user.isGlobalAdmin,
  });

  return (
    <DashboardLayout
      user={{
        name: session.user.name,
        email: session.user.email,
        isGlobalAdmin: session.user.isGlobalAdmin,
      }}
      activeCompany={activeCompany}
      breadcrumb={[{ label: tNav("admin") }]}
    >
      <div className="space-y-8">
        <PageHeader title={t("title")} description={t("description")} />

        <AdminOverview
          userCount={users.length}
          companyCount={companies.length}
          adminCount={adminCount}
        />

        <Section title={t("llmProviders")}>
          <LlmConfigSection initialProviders={providers} />
        </Section>

        <Section title={t("users")}>
          <AdminUsersTable users={users} />
        </Section>

        <Section title={t("companies")}>
          <AdminCompaniesTable companies={companies} />
        </Section>
      </div>
    </DashboardLayout>
  );
}
