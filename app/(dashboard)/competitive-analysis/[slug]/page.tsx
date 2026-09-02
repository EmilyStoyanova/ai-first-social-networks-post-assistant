import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { auth } from "@/lib/auth";
import { getCompany } from "@/lib/services/company/get-company.service";
import { getResearchProfileOrDefaults } from "@/lib/services/competitive-analysis/get-research-profile-or-defaults.service";
import { listCompetitors } from "@/lib/services/competitive-analysis/list-competitors.service";
import { DashboardLayout } from "@/components/dashboard/dashboard-layout";
import { CompetitiveAnalysisHeader } from "@/components/competitive-analysis/analysis-header";
import { OverviewPanel } from "@/components/competitive-analysis/overview-panel";

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Competitive Analysis – ${slug} – AI-First Post Assistant` };
}

/**
 * The Competitive Analysis module for one company (its own route root).
 * Overview — the module's default tab. Part 3A: Research Profile (read
 * without write — see get-research-profile-or-defaults.service.ts) and the
 * active competitor count. No aggregate/trend data yet (Part 3B).
 */
export default async function CompetitiveAnalysisOverviewPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const { slug } = await params;
  const company = await getCompany(slug, session.user.id, session.user.isGlobalAdmin);
  if (!company) notFound();

  // Current application locale — seeds an UNPERSISTED profile's
  // `analysisLanguage` default only (2026-09-02 ownership-boundary fix); a
  // saved profile's language always comes from the database. See
  // get-research-profile-or-defaults.service.ts.
  const appLocale = await getLocale();

  const [profileResult, competitorsResult] = await Promise.all([
    getResearchProfileOrDefaults(slug, session.user.id, session.user.isGlobalAdmin, appLocale),
    listCompetitors(slug, session.user.id, session.user.isGlobalAdmin, "active"),
  ]);

  // Both were already resolved once via getCompany above — a NOT_FOUND here
  // would mean access was revoked mid-request, same edge case every other
  // page's secondary fetch has.
  if (!profileResult.success || !competitorsResult.success) notFound();

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
        <CompetitiveAnalysisHeader slug={slug} activeTab="overview" />
        <OverviewPanel
          slug={slug}
          profile={profileResult.profile}
          isOwner={profileResult.isOwner}
          activeCompetitorCount={competitorsResult.competitors.length}
        />
      </div>
    </DashboardLayout>
  );
}
