import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/lib/auth";
import { getCompany } from "@/lib/services/company/get-company.service";
import { getBrandGuidelines } from "@/lib/services/company/get-brand-guidelines.service";
import { getBufferConnection } from "@/lib/services/buffer/get-buffer-connection.service";
import { getAnalyticsKeyStatus } from "@/lib/services/analytics/manage-analytics-key.service";
import { listChannelConfigs } from "@/lib/services/company/list-channel-configs.service";
import { DashboardLayout } from "@/components/dashboard/dashboard-layout";
import { CompanyWorkspaceHeader } from "@/components/company/company-workspace-header";
import { BrandGuidelinesForm } from "@/components/company/brand-guidelines-form";
import { BufferConnectionCard } from "@/components/company/buffer-connection-card";
import { AnalyticsKeyCard } from "@/components/company/analytics-key-card";
import { ChannelConfigSection } from "@/components/company/channel-config-section";
import { Section } from "@/components/ui/Section";

interface Props {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Settings – ${slug} – AI-First Post Assistant` };
}

export default async function CompanySettingsPage({ params, searchParams }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const [{ slug }, sp] = await Promise.all([params, searchParams]);

  const company = await getCompany(slug, session.user.id, session.user.isGlobalAdmin);
  if (!company) notFound();

  const tNav = await getTranslations("navigation");
  const t = await getTranslations("companyPage");
  const canManage = company.role === "OWNER" || session.user.isGlobalAdmin;

  const [brandGuidelines, bufferConnection, channelConfigs, analyticsKeyStatus] = await Promise.all(
    [
      getBrandGuidelines(company.id),
      getBufferConnection(company.id),
      listChannelConfigs(slug, session.user.id, session.user.isGlobalAdmin),
      getAnalyticsKeyStatus(slug, session.user.id, session.user.isGlobalAdmin),
    ]
  );

  const bufferParam = typeof sp.buffer === "string" ? sp.buffer : null;
  const configs = channelConfigs?.success ? channelConfigs.configs : [];

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
        <CompanyWorkspaceHeader company={company} activeTab="settings" />

        <div className="mt-8">
          <div className="space-y-10">
            <Section id="brand" title={t("sections.brand")}>
              <BrandGuidelinesForm
                slug={slug}
                initialValues={brandGuidelines}
                initialAutomationMode={company?.automationMode ?? "semi_automated"}
                role={company?.role ?? null}
                isGlobalAdmin={false}
              />
            </Section>

            <Section id="buffer" title={t("sections.integrations")}>
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

              {/* Analytics key — its own card because it is a different credential with
                  a different lifecycle, and removing it must not read as affecting
                  publishing. */}
              <AnalyticsKeyCard
                slug={slug}
                canManage={canManage}
                // An editor cannot read key status (the service is owner-scoped);
                // the card then renders its read-only "not configured" state.
                initialStatus={
                  analyticsKeyStatus?.success
                    ? analyticsKeyStatus.data
                    : {
                        bufferConnected: bufferConnection.connected,
                        configured: false,
                        last4: null,
                        addedAt: null,
                        lastValidAt: null,
                      }
                }
              />
            </Section>

            <Section
              id="channels"
              title={t("sections.channels")}
              description={t("sections.channelsDesc")}
            >
              <ChannelConfigSection
                slug={slug}
                initialConfigs={configs}
                canManage={canManage}
                bufferConnected={bufferConnection.connected}
                lastSyncedAt={bufferConnection.lastProfileSyncAt?.toISOString() ?? null}
                companyAutomationMode={company?.automationMode ?? "semi_automated"}
              />
            </Section>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
