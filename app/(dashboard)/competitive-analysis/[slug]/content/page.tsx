import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getCompany } from "@/lib/services/company/get-company.service";
import { listCompetitorContent } from "@/lib/services/competitive-analysis/list-competitor-content.service";
import { listCompetitors } from "@/lib/services/competitive-analysis/list-competitors.service";
import { getResearchProfileOrDefaults } from "@/lib/services/competitive-analysis/get-research-profile-or-defaults.service";
import { DashboardLayout } from "@/components/dashboard/dashboard-layout";
import { CompetitiveAnalysisHeader } from "@/components/competitive-analysis/analysis-header";
import { ContentPanel } from "@/components/competitive-analysis/content-panel";

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Content – Competitive Analysis – ${slug} – AI-First Post Assistant` };
}

/**
 * Real implementation (Part 3B §16), replacing the Part 3A placeholder.
 * "Observed content from monitored competitor sources" — see
 * `content-panel.tsx`'s own comment on why the wording stays deliberately
 * non-exhaustive.
 */
export default async function CompetitiveAnalysisContentPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const { slug } = await params;
  const company = await getCompany(slug, session.user.id, session.user.isGlobalAdmin);
  if (!company) notFound();

  const [contentResult, competitorsResult, profileResult] = await Promise.all([
    listCompetitorContent(slug, session.user.id, session.user.isGlobalAdmin),
    listCompetitors(slug, session.user.id, session.user.isGlobalAdmin, "active"),
    // 2026-09 relevance-UI fix — `persisted` (not the lazily-computed default)
    // is what distinguishes "genuinely awaiting evaluation" from "no Research
    // Profile has ever been saved, so nothing can ever evaluate these rows".
    // See `relevance-display-state.ts`.
    getResearchProfileOrDefaults(slug, session.user.id, session.user.isGlobalAdmin),
  ]);
  if (!contentResult.success || !competitorsResult.success || !profileResult.success) notFound();

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
        <CompetitiveAnalysisHeader slug={slug} activeTab="content" />
        {/* Keyed on `slug` — same cross-company state-leak fix as the
            Competitors panel (see that page's comment). */}
        <ContentPanel
          key={slug}
          slug={slug}
          initialItems={contentResult.items}
          competitors={competitorsResult.competitors.map((c) => ({ id: c.id, name: c.name }))}
          canManage={canManage}
          profileConfigured={profileResult.profile.persisted}
        />
      </div>
    </DashboardLayout>
  );
}
