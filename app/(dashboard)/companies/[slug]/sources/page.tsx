import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/lib/auth";
import { getCompany } from "@/lib/services/company/get-company.service";
import { listContentSources } from "@/lib/services/company/list-content-sources.service";
import { getContentMix } from "@/lib/services/company/get-content-mix.service";
import { DashboardLayout } from "@/components/dashboard/dashboard-layout";
import { CompanyWorkspaceHeader } from "@/components/company/company-workspace-header";
import { ContentSourcesSection } from "@/components/company/content-sources-section";
import { ContentMixSection } from "@/components/company/content-mix-section";

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Sources – ${slug} – AI-First Post Assistant` };
}

export default async function CompanySourcesPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const { slug } = await params;

  const company = await getCompany(slug, session.user.id, session.user.isGlobalAdmin);
  if (!company) notFound();

  const tNav = await getTranslations("navigation");
  const canManage = company.role === "OWNER" || session.user.isGlobalAdmin;

  const [contentSources, contentMix] = await Promise.all([
    listContentSources(slug, session.user.id, session.user.isGlobalAdmin),
    getContentMix(slug, session.user.id, session.user.isGlobalAdmin),
  ]);

  const sources = contentSources?.success ? contentSources.sources : [];
  const mix = contentMix?.success ? contentMix.mix : null;

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
        <CompanyWorkspaceHeader company={company} activeTab="sources" />

        <div className="mt-8">
          <div className="space-y-8">
            <ContentSourcesSection slug={slug} initialSources={sources} canManage={canManage} />
            {/* The mix divides the weekly budget across the sources above, so
                it reads directly beneath them. Hidden until a source exists —
                there is nothing to distribute otherwise.
                Phase 4b relocates this to Settings → Channels (§2.3). */}
            {mix && sources.length > 0 && (
              <ContentMixSection slug={slug} initialMix={mix} canManage={canManage} />
            )}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
