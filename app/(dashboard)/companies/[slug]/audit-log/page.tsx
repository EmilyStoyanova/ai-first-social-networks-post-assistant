import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getCompany } from "@/lib/services/company/get-company.service";
import { listCompanyAuditLogs } from "@/lib/services/audit/audit-log.service";
import { DashboardLayout } from "@/components/dashboard/dashboard-layout";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { AuditLogTimeline } from "@/components/company/audit-log-timeline";

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Audit Log – ${slug} – AI-First Post Assistant` };
}

export default async function AuditLogPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const { slug } = await params;

  const company = await getCompany(slug, session.user.id, session.user.isGlobalAdmin);
  if (!company) notFound();

  const logs = await listCompanyAuditLogs(company.id, { limit: 50 });

  return (
    <DashboardLayout
      user={{
        name: session.user.name,
        email: session.user.email,
        isGlobalAdmin: session.user.isGlobalAdmin,
      }}
      breadcrumb={[
        { label: "Companies", href: "/companies" },
        { label: company.name, href: `/companies/${slug}` },
        { label: "Audit Log" },
      ]}
    >
      <div className="space-y-6">
        <PageHeader
          title="Audit Log"
          description="A chronological record of all actions taken on posts and content for this company."
          actions={
            <Button href={`/companies/${slug}`} variant="secondary" size="sm">
              ← Back to Company
            </Button>
          }
        />

        <AuditLogTimeline logs={logs} />
      </div>
    </DashboardLayout>
  );
}
