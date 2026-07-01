import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { listCompanies } from "@/lib/services/company/list-companies.service";
import { DashboardLayout } from "@/components/dashboard/dashboard-layout";
import { CompanyList } from "@/components/company/company-list";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";

export const metadata: Metadata = {
  title: "Companies – AI-First Post Assistant",
};

export default async function CompaniesPage() {
  const session = await auth();
  if (!session) redirect("/login");

  const companies = await listCompanies(session.user.id, session.user.isGlobalAdmin);
  const description = companies.length === 1 ? "1 company" : `${companies.length} companies`;

  return (
    <DashboardLayout
      user={{
        name: session.user.name,
        email: session.user.email,
        isGlobalAdmin: session.user.isGlobalAdmin,
      }}
    >
      <div className="space-y-6">
        <PageHeader
          title="Companies"
          description={description}
          actions={
            <Button href="/companies/new" variant="primary">
              + Create Company
            </Button>
          }
        />

        <CompanyList companies={companies} />
      </div>
    </DashboardLayout>
  );
}
