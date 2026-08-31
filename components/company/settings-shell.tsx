import { getTranslations } from "next-intl/server";
import type { CompanyDetails } from "@/lib/services/company/get-company.service";
import { DashboardLayout } from "@/components/dashboard/dashboard-layout";
import { CompanyWorkspaceHeader } from "@/components/company/company-workspace-header";
import { SettingsNav, type SettingsSection } from "./settings-nav";

interface Props {
  company: CompanyDetails;
  user: { name?: string | null; email?: string | null; isGlobalAdmin?: boolean };
  active: SettingsSection;
  children: React.ReactNode;
}

/**
 * Chrome shared by every Settings sub-page: workspace header, sub-navigation,
 * and the content column.
 *
 * A component rather than a route `layout.tsx` because each sub-page already
 * loads the company for its own data — a layout would fetch it a second time
 * per request, and Prisma calls are not deduplicated the way `fetch` is.
 *
 * The content column is capped at 640px per §4.10: these are forms, and a form
 * field stretched across a desktop viewport is harder to read, not easier.
 */
export async function SettingsShell({ company, user, active, children }: Props) {
  const tNav = await getTranslations("navigation");

  return (
    <DashboardLayout
      user={user}
      activeCompany={{ slug: company.slug, name: company.name }}
      breadcrumb={[{ label: tNav("companies"), href: "/companies" }, { label: company.name }]}
    >
      <div>
        <CompanyWorkspaceHeader company={company} activeTab="settings" />

        <div className="mt-8 grid gap-8 lg:grid-cols-[180px_minmax(0,1fr)]">
          <SettingsNav slug={company.slug} active={active} />
          <div className="min-w-0 lg:max-w-[640px]">{children}</div>
        </div>
      </div>
    </DashboardLayout>
  );
}
