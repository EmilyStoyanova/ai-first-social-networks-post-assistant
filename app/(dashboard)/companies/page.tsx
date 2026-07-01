import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { listCompanies } from "@/lib/services/company/list-companies.service";
import { DashboardLayout } from "@/components/dashboard/dashboard-layout";
import { CompanyList } from "@/components/company/company-list";

export const metadata: Metadata = {
  title: "Companies – AI-First Post Assistant",
};

export default async function CompaniesPage() {
  const session = await auth();
  if (!session) redirect("/login");

  const companies = await listCompanies(session.user.id, session.user.isGlobalAdmin);

  return (
    <DashboardLayout user={{ name: session.user.name, email: session.user.email }}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-gray-900">Companies</h1>
            <p className="mt-1 text-sm text-gray-500">
              {companies.length === 1 ? "1 company" : `${companies.length} companies`}
            </p>
          </div>
          <Link
            href="/companies/new"
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
          >
            + Create Company
          </Link>
        </div>

        <CompanyList companies={companies} />
      </div>
    </DashboardLayout>
  );
}
