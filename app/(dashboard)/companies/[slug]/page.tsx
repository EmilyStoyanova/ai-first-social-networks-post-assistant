import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { CheckSquare2, ClipboardList, Image, Pencil, Radio, BarChart2 } from "lucide-react";
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
import { listPosts } from "@/lib/services/company/list-posts.service";
import { DashboardLayout } from "@/components/dashboard/dashboard-layout";
import { CompanyWorkspaceHeader } from "@/components/company/company-workspace-header";
import { BrandGuidelinesForm } from "@/components/company/brand-guidelines-form";
import { CompanyMembers } from "@/components/company/company-members";
import { BufferConnectionCard } from "@/components/company/buffer-connection-card";
import { ChannelConfigSection } from "@/components/company/channel-config-section";
import { ContentSourcesSection } from "@/components/company/content-sources-section";
import { GeneratedPostsSection } from "@/components/company/generated-posts-section";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Section } from "@/components/ui/Section";
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
  let membersResult: Awaited<ReturnType<typeof listMembers>> | null = null;

  if (activeTab === "posts") {
    [postsData, bufferConnection] = await Promise.all([
      listPosts(slug, session.user.id, session.user.isGlobalAdmin),
      getBufferConnection(company.id),
    ]);
  }

  if (activeTab === "sources") {
    contentSources = await listContentSources(slug, session.user.id, session.user.isGlobalAdmin);
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
            <OverviewTab company={company} slug={slug} canManage={canManage} />
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
            />
          )}

          {/* ── Sources ────────────────────────────────────────────────── */}
          {activeTab === "sources" && (
            <ContentSourcesSection slug={slug} initialSources={sources} canManage={canManage} />
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
          {activeTab === "settings" && brandGuidelines !== null && bufferConnection && (
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
}

async function OverviewTab({ company, slug }: OverviewTabProps) {
  if (!company) return null;
  const t = await getTranslations("overview");
  const tPage = await getTranslations("companyPage");

  const formattedDate = company.createdAt.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const QUICK_ACCESS = [
    {
      icon: Pencil,
      label: "Posts",
      desc: tPage("modules.postsDesc"),
      href: `/companies/${slug}?tab=posts`,
    },
    {
      icon: CheckSquare2,
      label: "Approval",
      desc: tPage("modules.approvalQueueDesc"),
      href: `/companies/${slug}/approval`,
    },
    {
      icon: Image,
      label: "Media",
      desc: tPage("modules.mediaGalleryDesc"),
      href: `/companies/${slug}/media`,
    },
    {
      icon: Radio,
      label: "Sources",
      desc: tPage("modules.contentSourcesDesc"),
      href: `/companies/${slug}?tab=sources`,
    },
    {
      icon: ClipboardList,
      label: "Activity",
      desc: tPage("modules.auditLogDesc"),
      href: `/companies/${slug}/audit-log`,
    },
    {
      icon: BarChart2,
      label: "Settings",
      desc: tPage("modules.analyticsDesc"),
      href: `/companies/${slug}?tab=settings`,
    },
  ];

  return (
    <div className="space-y-8">
      {/* Company metadata */}
      <Card className="px-6 py-6">
        <dl className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <dt className="text-micro text-fg-faint tracking-widest uppercase">{t("name")}</dt>
            <dd className="text-fg mt-1.5 text-sm font-semibold">{company.name}</dd>
          </div>
          <div>
            <dt className="text-micro text-fg-faint tracking-widest uppercase">{t("slug")}</dt>
            <dd className="text-fg-muted mt-1.5 font-mono text-sm">{company.slug}</dd>
          </div>
          <div>
            <dt className="text-micro text-fg-faint tracking-widest uppercase">{t("website")}</dt>
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
            <dt className="text-micro text-fg-faint tracking-widest uppercase">{t("role")}</dt>
            <dd className="mt-1.5">
              {company.role && (
                <Badge variant={company.role === "OWNER" ? "owner" : "editor"}>
                  {company.role}
                </Badge>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-micro text-fg-faint tracking-widest uppercase">{t("created")}</dt>
            <dd className="text-fg-muted mt-1.5 text-sm">{formattedDate}</dd>
          </div>
        </dl>
      </Card>

      {/* Quick access */}
      <Section title={tPage("sections.modules")}>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {QUICK_ACCESS.map(({ icon: Icon, label, desc, href }) => (
            <Link key={href} href={href}>
              <Card variant="hover" className="px-6 py-5">
                <Icon className="text-fg-faint mb-3 h-5 w-5" aria-hidden />
                <h3 className="text-fg text-sm font-semibold">{label}</h3>
                <p className="text-fg-muted mt-1 text-sm leading-relaxed">{desc}</p>
              </Card>
            </Link>
          ))}
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
      <Section title={t("sections.brand")}>
        <BrandGuidelinesForm
          slug={slug}
          initialValues={brandGuidelines}
          role={company?.role ?? null}
          isGlobalAdmin={false}
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
    </div>
  );
}
