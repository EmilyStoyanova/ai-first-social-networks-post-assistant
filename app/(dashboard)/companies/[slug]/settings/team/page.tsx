import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/lib/auth";
import { getCompany } from "@/lib/services/company/get-company.service";
import { listMembers } from "@/lib/services/company/list-members.service";
import { DashboardLayout } from "@/components/dashboard/dashboard-layout";
import { CompanyWorkspaceHeader } from "@/components/company/company-workspace-header";
import { CompanyMembers } from "@/components/company/company-members";

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Team – ${slug} – AI-First Post Assistant` };
}

export default async function CompanyTeamPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const { slug } = await params;

  const company = await getCompany(slug, session.user.id, session.user.isGlobalAdmin);
  if (!company) notFound();

  const tNav = await getTranslations("navigation");
  const canManage = company.role === "OWNER" || session.user.isGlobalAdmin;

  const membersResult = await listMembers(slug, session.user.id, session.user.isGlobalAdmin);
  const members = membersResult?.success
    ? membersResult.members.map((m) => ({ ...m, joinedAt: m.joinedAt.toISOString() }))
    : [];

  return (
    <DashboardLayout
      user={{
        name: session.user.name,
        email: session.user.email,
        isGlobalAdmin: session.user.isGlobalAdmin,
      }}
      breadcrumb={[{ label: tNav("companies"), href: "/companies" }, { label: company.name }]}
    >
      <div>
        {/* Team keeps its own tab in the bar until Phase 4b builds the Settings
            sub-navigation; only its route has moved. */}
        <CompanyWorkspaceHeader company={company} activeTab="team" />

        <div className="mt-8">
          <CompanyMembers
            slug={slug}
            initialMembers={members}
            currentUserEmail={session.user.email}
            canManage={canManage}
          />
        </div>
      </div>
    </DashboardLayout>
  );
}
