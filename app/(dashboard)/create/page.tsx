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
  title: "Company Management – AI-First Post Assistant",
};

/**
 * Company Management entry point — a RESOLVER SHIM, not a page.
 *
 * The nav item has to carry a static href (`Navigation` is a client component
 * with no session or cookie access), but the company it should open is only
 * knowable on the server. This route closes that gap: it resolves the active
 * company and redirects into that company's existing management workspace at
 * `/companies/{slug}`.
 *
 * Deliberately NOT a company picker, and deliberately not a second copy of the
 * workspace. The header's `CompanySelector` is the one company-selection UI in
 * the app, and `/companies/{slug}/...` is the one company-management surface —
 * duplicating either here would put the same state in two places, which is
 * exactly what the previous `/create` → `/create/{slug}` hop did (a company in
 * the route AND in the selector's cookie, able to disagree).
 *
 * The empty state below is not a picker either: `resolveActiveCompany` already
 * falls back to "first accessible company" before giving up, so reaching it
 * means the user genuinely has no company yet.
 */
export default async function CompanyManagementEntryPage() {
  const session = await auth();
  if (!session) redirect("/login");

  const cookieSlug = (await cookies()).get("active_company")?.value ?? null;
  const activeCompany = await resolveActiveCompany({
    cookieSlug,
    userId: session.user.id,
    isGlobalAdmin: session.user.isGlobalAdmin,
  });

  // `resolveActiveCompany` re-validates the slug through `getCompany`, so a
  // stale or foreign cookie can never redirect a user into a company they are
  // not a member of — it falls back instead.
  if (activeCompany) redirect(`/companies/${activeCompany.slug}`);

  const t = await getTranslations("companyManagement");

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
