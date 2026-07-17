import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  CheckSquare2,
  ClipboardList,
  Image as ImageIcon,
  Pencil,
  Radio,
  Settings2,
} from "lucide-react";
import { auth } from "@/lib/auth";
import { getCompany } from "@/lib/services/company/get-company.service";
import { getBrandGuidelines } from "@/lib/services/company/get-brand-guidelines.service";
import { listMembers } from "@/lib/services/company/list-members.service";
import { getBufferConnection } from "@/lib/services/buffer/get-buffer-connection.service";
import {
  listChannelConfigs,
  type ChannelConfigItem,
} from "@/lib/services/company/list-channel-configs.service";
import { listContentSources } from "@/lib/services/company/list-content-sources.service";
import { getContentMix } from "@/lib/services/company/get-content-mix.service";
import { hasEnabledFeedItems } from "@/lib/services/company/list-feed-items.service";
import { listPosts } from "@/lib/services/company/list-posts.service";
import { DashboardLayout } from "@/components/dashboard/dashboard-layout";
import { CompanyWorkspaceHeader } from "@/components/company/company-workspace-header";
import { BrandGuidelinesForm } from "@/components/company/brand-guidelines-form";
import { CompanyMembers } from "@/components/company/company-members";
import { BufferConnectionCard } from "@/components/company/buffer-connection-card";
import { SetupChecklist } from "@/components/company/setup-checklist";
import { ChannelConfigSection } from "@/components/company/channel-config-section";
import { ContentSourcesSection } from "@/components/company/content-sources-section";
import { ContentMixSection } from "@/components/company/content-mix-section";
import { GeneratedPostsSection } from "@/components/company/generated-posts-section";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Section } from "@/components/ui/Section";
import { formatDateLong } from "@/lib/i18n/format-date";
import Link from "next/link";

interface Props {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `${slug} – AI-First Post Assistant` };
}

const MAIN_TABS = ["overview", "posts", "sources", "team", "settings"] as const;
type MainTab = (typeof MAIN_TABS)[number];

function resolveTab(raw: string | string[] | undefined): MainTab {
  if (typeof raw === "string" && (MAIN_TABS as readonly string[]).includes(raw)) {
    return raw as MainTab;
  }
  return "overview";
}

export default async function CompanyPage({ params, searchParams }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const activeTab = resolveTab(sp.tab);

  const company = await getCompany(slug, session.user.id, session.user.isGlobalAdmin);
  if (!company) notFound();

  const tNav = await getTranslations("navigation");
  const canManage = company.role === "OWNER" || session.user.isGlobalAdmin;
  const canDelete = canManage;
  const canPublish = canManage;

  // ── Per-tab data fetching ─────────────────────────────────────────────────
  let postsData: Awaited<ReturnType<typeof listPosts>> | null = null;
  let bufferConnection: Awaited<ReturnType<typeof getBufferConnection>> | null = null;
  let brandGuidelines: Awaited<ReturnType<typeof getBrandGuidelines>> | null = null;
  let channelConfigs: Awaited<ReturnType<typeof listChannelConfigs>> | null = null;
  let contentSources: Awaited<ReturnType<typeof listContentSources>> | null = null;
  let contentMix: Awaited<ReturnType<typeof getContentMix>> | null = null;
  let membersResult: Awaited<ReturnType<typeof listMembers>> | null = null;

  if (activeTab === "overview") {
    [brandGuidelines, bufferConnection, channelConfigs] = await Promise.all([
      getBrandGuidelines(company.id),
      getBufferConnection(company.id),
      listChannelConfigs(slug, session.user.id, session.user.isGlobalAdmin),
    ]);
  }

  let rssFeedItemsAvailable = false;

  if (activeTab === "posts") {
    [postsData, bufferConnection, rssFeedItemsAvailable] = await Promise.all([
      listPosts(slug, session.user.id, session.user.isGlobalAdmin),
      getBufferConnection(company.id),
      hasEnabledFeedItems(company.id),
    ]);
  }

  if (activeTab === "sources") {
    [contentSources, contentMix] = await Promise.all([
      listContentSources(slug, session.user.id, session.user.isGlobalAdmin),
      getContentMix(slug, session.user.id, session.user.isGlobalAdmin),
    ]);
  }

  if (activeTab === "team") {
    membersResult = await listMembers(slug, session.user.id, session.user.isGlobalAdmin);
  }

  if (activeTab === "settings") {
    const bufferParam = typeof sp.buffer === "string" ? sp.buffer : null;
    [brandGuidelines, bufferConnection, channelConfigs] = await Promise.all([
      getBrandGuidelines(company.id),
      getBufferConnection(company.id),
      listChannelConfigs(slug, session.user.id, session.user.isGlobalAdmin),
    ]);
    void bufferParam; // captured below where needed
  }

  const bufferParam = typeof sp.buffer === "string" ? sp.buffer : null;

  const initialPosts = postsData?.success ? postsData.posts : [];
  const sources = contentSources?.success ? contentSources.sources : [];
  const mix = contentMix?.success ? contentMix.mix : null;
  const members = membersResult?.success
    ? membersResult.members.map((m) => ({ ...m, joinedAt: m.joinedAt.toISOString() }))
    : [];
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
        <CompanyWorkspaceHeader company={company} activeTab={activeTab} />

        <div className="mt-8">
          {/* ── Overview ───────────────────────────────────────────────── */}
          {activeTab === "overview" && (
            <OverviewTab
              company={company}
              slug={slug}
              canManage={canManage}
              brandGuidelines={brandGuidelines}
              bufferConnection={bufferConnection}
              channelConfigs={channelConfigs?.success ? channelConfigs.configs : []}
            />
          )}

          {/* ── Posts ──────────────────────────────────────────────────── */}
          {activeTab === "posts" && bufferConnection && (
            <GeneratedPostsSection
              slug={slug}
              initialPosts={initialPosts}
              canDelete={canDelete}
              canPublish={canPublish}
              canApprove={canManage}
              bufferConnected={bufferConnection.connected}
              hasRssFeedItems={rssFeedItemsAvailable}
            />
          )}

          {/* ── Sources ────────────────────────────────────────────────── */}
          {activeTab === "sources" && (
            <div className="space-y-8">
              <ContentSourcesSection slug={slug} initialSources={sources} canManage={canManage} />
              {/* The mix divides the weekly budget across the sources above, so
                  it reads directly beneath them. Hidden until a source exists —
                  there is nothing to distribute otherwise. */}
              {mix && sources.length > 0 && (
                <ContentMixSection slug={slug} initialMix={mix} canManage={canManage} />
              )}
            </div>
          )}

          {/* ── Team ───────────────────────────────────────────────────── */}
          {activeTab === "team" && (
            <CompanyMembers
              slug={slug}
              initialMembers={members}
              currentUserEmail={session.user.email}
              canManage={canManage}
            />
          )}

          {/* ── Settings ───────────────────────────────────────────────── */}
          {activeTab === "settings" && bufferConnection !== null && (
            <SettingsTab
              slug={slug}
              brandGuidelines={brandGuidelines}
              bufferConnection={bufferConnection}
              channelConfigs={configs}
              company={company}
              canManage={canManage}
              bufferParam={bufferParam}
            />
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}

// ── Overview tab ─────────────────────────────────────────────────────────────

interface OverviewTabProps {
  company: Awaited<ReturnType<typeof getCompany>>;
  slug: string;
  canManage: boolean;
  brandGuidelines: Awaited<ReturnType<typeof getBrandGuidelines>> | null;
  bufferConnection: Awaited<ReturnType<typeof getBufferConnection>> | null;
  channelConfigs: ChannelConfigItem[];
}

async function OverviewTab({
  company,
  slug,
  brandGuidelines,
  bufferConnection,
  channelConfigs,
}: OverviewTabProps) {
  if (!company) return null;
  const t = await getTranslations("overview");
  const tPage = await getTranslations("companyPage");
  const tWs = await getTranslations("workspace");

  const formattedDate = formatDateLong(company.createdAt);

  const PRIMARY_CARDS = [
    {
      icon: Pencil,
      label: tWs("tabs.posts"),
      desc: tPage("modules.postsDesc"),
      href: `/companies/${slug}?tab=posts`,
    },
    {
      icon: CheckSquare2,
      label: tWs("tabs.approval"),
      desc: tPage("modules.approvalQueueDesc"),
      href: `/companies/${slug}/approval`,
    },
  ];

  const SECONDARY_CARDS = [
    {
      icon: ImageIcon,
      label: tWs("tabs.media"),
      desc: tPage("modules.mediaGalleryDesc"),
      href: `/companies/${slug}/media`,
    },
    {
      icon: Radio,
      label: tWs("tabs.sources"),
      desc: tPage("sections.contentSourcesDesc"),
      href: `/companies/${slug}?tab=sources`,
    },
    {
      icon: ClipboardList,
      label: tWs("tabs.activity"),
      desc: tPage("modules.auditLogDesc"),
      href: `/companies/${slug}/audit-log`,
    },
    {
      icon: Settings2,
      label: tWs("tabs.settings"),
      desc: tPage("modules.channelsDesc"),
      href: `/companies/${slug}?tab=settings`,
    },
  ];

  const brandDescribed = !!brandGuidelines?.companyDescription?.trim();
  const bufferConnected = bufferConnection?.connected ?? false;
  const profilesSynced = !!bufferConnection?.lastProfileSyncAt;
  const hasEnabledChannel = channelConfigs.some((c) => c.enabled);

  return (
    <div className="space-y-8">
      {/* Onboarding checklist — hidden once all required steps are done and user has visited */}
      <SetupChecklist
        slug={slug}
        brandDescribed={brandDescribed}
        bufferConnected={bufferConnected}
        profilesSynced={profilesSynced}
        hasEnabledChannel={hasEnabledChannel}
      />

      {/* Company metadata */}
      <Card className="px-6 py-6">
        <dl className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <dt className="text-micro text-fg-faint">{t("name")}</dt>
            <dd className="text-fg mt-1.5 text-sm font-semibold">{company.name}</dd>
          </div>
          <div>
            <dt className="text-micro text-fg-faint">{t("slug")}</dt>
            <dd className="text-fg-muted mt-1.5 font-mono text-sm">{company.slug}</dd>
          </div>
          <div>
            <dt className="text-micro text-fg-faint">{t("website")}</dt>
            <dd className="mt-1.5">
              {company.website ? (
                <a
                  href={company.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:text-fg text-sm transition-colors hover:underline"
                >
                  {company.website}
                </a>
              ) : (
                <span className="text-fg-faint text-sm">{t("noWebsite")}</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-micro text-fg-faint">{t("role")}</dt>
            <dd className="mt-1.5">
              {company.role && (
                <Badge variant={company.role === "OWNER" ? "owner" : "editor"}>
                  {company.role}
                </Badge>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-micro text-fg-faint">{t("created")}</dt>
            <dd className="text-fg-muted mt-1.5 text-sm">{formattedDate}</dd>
          </div>
        </dl>
      </Card>

      {/* Quick access */}
      <Section title={tPage("sections.modules")}>
        <div className="space-y-3">
          {/* Primary: Posts + Approval */}
          <div className="grid gap-3 sm:grid-cols-2">
            {PRIMARY_CARDS.map(({ icon: Icon, label, desc, href }) => (
              <Link key={href} href={href}>
                <Card variant="hover" className="px-6 py-6">
                  <Icon className="text-fg-muted mb-4 h-6 w-6" aria-hidden />
                  <h3 className="text-fg text-sm font-semibold">{label}</h3>
                  <p className="text-fg-muted mt-1 text-sm leading-relaxed">{desc}</p>
                </Card>
              </Link>
            ))}
          </div>

          {/* Secondary: Media, Sources, Activity, Settings */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {SECONDARY_CARDS.map(({ icon: Icon, label, desc, href }) => (
              <Link key={href} href={href}>
                <Card variant="hover" className="px-5 py-4">
                  <Icon className="text-fg-faint mb-2.5 h-6 w-6" aria-hidden />
                  <h3 className="text-fg-muted text-sm font-medium">{label}</h3>
                  <p className="text-fg-faint mt-0.5 text-xs leading-snug">{desc}</p>
                </Card>
              </Link>
            ))}
          </div>
        </div>
      </Section>
    </div>
  );
}

// ── Settings tab ─────────────────────────────────────────────────────────────

interface SettingsTabProps {
  slug: string;
  brandGuidelines: Awaited<ReturnType<typeof getBrandGuidelines>>;
  bufferConnection: Awaited<ReturnType<typeof getBufferConnection>>;
  channelConfigs: ChannelConfigItem[];
  company: Awaited<ReturnType<typeof getCompany>>;
  canManage: boolean;
  bufferParam: string | null;
}

async function SettingsTab({
  slug,
  brandGuidelines,
  bufferConnection,
  channelConfigs,
  company,
  canManage,
  bufferParam,
}: SettingsTabProps) {
  const t = await getTranslations("companyPage");

  return (
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
      </Section>

      <Section
        id="channels"
        title={t("sections.channels")}
        description={t("sections.channelsDesc")}
      >
        <ChannelConfigSection
          slug={slug}
          initialConfigs={channelConfigs}
          canManage={canManage}
          bufferConnected={bufferConnection.connected}
          lastSyncedAt={bufferConnection.lastProfileSyncAt?.toISOString() ?? null}
          companyAutomationMode={company?.automationMode ?? "semi_automated"}
        />
      </Section>
    </div>
  );
}
