import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { DashboardLayout } from "@/components/dashboard/dashboard-layout";
import { CreateCompanyForm } from "@/components/company/create-company-form";

export const metadata: Metadata = {
  title: "New Company – AI-First Post Assistant",
};

export default async function NewCompanyPage() {
  const session = await auth();
  if (!session) redirect("/login");

  return (
    <DashboardLayout
      user={{ name: session.user.name, email: session.user.email }}
      breadcrumb={[{ label: "Companies", href: "/companies" }, { label: "New Company" }]}
    >
      <CreateCompanyForm />
    </DashboardLayout>
  );
}
