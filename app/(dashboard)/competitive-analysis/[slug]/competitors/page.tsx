import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getCompany } from "@/lib/services/company/get-company.service";
import { listCompetitors } from "@/lib/services/competitive-analysis/list-competitors.service";
import { DashboardLayout } from "@/components/dashboard/dashboard-layout";
import { CompetitiveAnalysisHeader } from "@/components/competitive-analysis/analysis-header";
import { CompetitorsPanel } from "@/components/competitive-analysis/competitors-panel";

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Competitors – ${slug} – AI-First Post Assistant` };
}

export default async function CompetitorsPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const { slug } = await params;
  const company = await getCompany(slug, session.user.id, session.user.isGlobalAdmin);
  if (!company) notFound();

  // "all" — the panel's own Active/Archived toggle filters client-side rather
  // than round-tripping; this is a management list, not a paginated feed.
  const result = await listCompetitors(slug, session.user.id, session.user.isGlobalAdmin, "all");
  if (!result.success) notFound();

  const canManage = company.role === "OWNER" || session.user.isGlobalAdmin;

  return (
    <DashboardLayout
      user={{
        name: session.user.name,
        email: session.user.email,
        isGlobalAdmin: session.user.isGlobalAdmin,
      }}
      activeCompany={{ slug: company.slug, name: company.name }}
    >
      <div className="space-y-6">
        <CompetitiveAnalysisHeader slug={slug} activeTab="competitors" />
        {/* Keyed on `slug` — same cross-company state-leak fix as Part 2's
            ContentCreationPanel (see that fix's comment): without it, the
            competitor list, filter, and any open add/edit form would survive
            a company switch since this client component would be reconciled
            as the same instance. */}
        <CompetitorsPanel
          key={slug}
          slug={slug}
          initialCompetitors={result.competitors}
          canManage={canManage}
        />
      </div>
    </DashboardLayout>
  );
}
