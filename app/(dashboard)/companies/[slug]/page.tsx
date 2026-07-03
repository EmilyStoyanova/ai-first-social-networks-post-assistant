import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/lib/auth";
import { getCompany } from "@/lib/services/company/get-company.service";
import { getBrandGuidelines } from "@/lib/services/company/get-brand-guidelines.service";
import { listMembers } from "@/lib/services/company/list-members.service";
import { getBufferConnection } from "@/lib/services/buffer/get-buffer-connection.service";
import { listChannelConfigs } from "@/lib/services/company/list-channel-configs.service";
import { listContentSources } from "@/lib/services/company/list-content-sources.service";
import { listPosts } from "@/lib/services/company/list-posts.service";
import { DashboardLayout } from "@/components/dashboard/dashboard-layout";
import { CompanyHeader } from "@/components/company/company-header";
import { CompanyOverview } from "@/components/company/company-overview";
import { CompanySectionCard } from "@/components/company/company-section-card";
import { BrandGuidelinesForm } from "@/components/company/brand-guidelines-form";
import { CompanyMembers } from "@/components/company/company-members";
import { BufferConnectionCard } from "@/components/company/buffer-connection-card";
import { ChannelConfigSection } from "@/components/company/channel-config-section";
import { ContentSourcesSection } from "@/components/company/content-sources-section";
import { GeneratedPostsSection } from "@/components/company/generated-posts-section";
import { Section } from "@/components/ui/Section";

interface Props {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `${slug} – AI-First Post Assistant` };
}

export default async function CompanyPage({ params, searchParams }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const [{ slug }, resolvedSearch] = await Promise.all([params, searchParams]);

  const company = await getCompany(slug, session.user.id, session.user.isGlobalAdmin);
  if (!company) notFound();

  const t = await getTranslations("companyPage");
  const tNav = await getTranslations("navigation");

  const [
    brandGuidelines,
    membersResult,
    bufferConnection,
    channelConfigsResult,
    contentSourcesResult,
    postsResult,
  ] = await Promise.all([
    getBrandGuidelines(company.id),
    listMembers(slug, session.user.id, session.user.isGlobalAdmin),
    getBufferConnection(company.id),
    listChannelConfigs(slug, session.user.id, session.user.isGlobalAdmin),
    listContentSources(slug, session.user.id, session.user.isGlobalAdmin),
    listPosts(slug, session.user.id, session.user.isGlobalAdmin),
  ]);

  const channelConfigs = channelConfigsResult.success ? channelConfigsResult.configs : [];
  const contentSources = contentSourcesResult.success ? contentSourcesResult.sources : [];
  const initialPosts = postsResult.success ? postsResult.posts : [];

  const members = membersResult.success
    ? membersResult.members.map((m) => ({ ...m, joinedAt: m.joinedAt.toISOString() }))
    : [];

  const canManage = company.role === "OWNER" || session.user.isGlobalAdmin;
  const canDelete = company.role === "OWNER" || session.user.isGlobalAdmin;
  const canPublish = canManage;

  const bufferParam = typeof resolvedSearch.buffer === "string" ? resolvedSearch.buffer : null;

  return (
    <DashboardLayout
      user={{
        name: session.user.name,
        email: session.user.email,
        isGlobalAdmin: session.user.isGlobalAdmin,
      }}
      breadcrumb={[{ label: tNav("companies"), href: "/companies" }, { label: company.name }]}
    >
      <div className="space-y-8">
        <CompanyHeader company={company} />
        <CompanyOverview company={company} />

        <Section title={t("sections.brand")}>
          <BrandGuidelinesForm
            slug={slug}
            initialValues={brandGuidelines}
            role={company.role}
            isGlobalAdmin={session.user.isGlobalAdmin}
          />
        </Section>

        <Section title={t("sections.members")}>
          <CompanyMembers
            slug={slug}
            initialMembers={members}
            currentUserEmail={session.user.email}
            canManage={canManage}
          />
        </Section>

        <Section title={t("sections.integrations")}>
          <BufferConnectionCard
            slug={slug}
            initialConnection={{
              connected: bufferConnection.connected,
              bufferUserId: bufferConnection.bufferUserId,
              connectedAt: bufferConnection.connectedAt?.toISOString() ?? null,
            }}
            canManage={canManage}
            bufferParam={bufferParam}
          />
        </Section>

        <Section title={t("sections.channels")} description={t("sections.channelsDesc")}>
          <ChannelConfigSection
            slug={slug}
            initialConfigs={channelConfigs}
            canManage={canManage}
            bufferConnected={bufferConnection.connected}
          />
        </Section>

        <Section
          title={t("sections.contentSources")}
          description={t("sections.contentSourcesDesc")}
        >
          <ContentSourcesSection
            slug={slug}
            initialSources={contentSources}
            canManage={canManage}
          />
        </Section>

        <Section title={t("sections.aiPosts")} description={t("sections.aiPostsDesc")}>
          <GeneratedPostsSection
            slug={slug}
            initialPosts={initialPosts}
            canDelete={canDelete}
            canPublish={canPublish}
            canApprove={canManage}
            bufferConnected={bufferConnection.connected}
          />
        </Section>

        <Section title={t("sections.modules")}>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <CompanySectionCard
              icon="🖼️"
              title={t("modules.mediaGallery")}
              description={t("modules.mediaGalleryDesc")}
              href={`/companies/${slug}/media`}
            />
            <CompanySectionCard
              icon="✅"
              title={t("modules.approvalQueue")}
              description={t("modules.approvalQueueDesc")}
              href={`/companies/${slug}/approval`}
            />
            <CompanySectionCard
              icon="📋"
              title={t("modules.auditLog")}
              description={t("modules.auditLogDesc")}
              href={`/companies/${slug}/audit-log`}
            />
            <CompanySectionCard
              icon="📡"
              title={t("modules.channels")}
              description={t("modules.channelsDesc")}
            />
            <CompanySectionCard
              icon="✍️"
              title={t("modules.posts")}
              description={t("modules.postsDesc")}
            />
            <CompanySectionCard
              icon="📊"
              title={t("modules.analytics")}
              description={t("modules.analyticsDesc")}
            />
          </div>
        </Section>
      </div>
    </DashboardLayout>
  );
}
