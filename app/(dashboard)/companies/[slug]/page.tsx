import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ClipboardList, Image as ImageIcon, Pencil, Radio, Settings2 } from "lucide-react";
import { auth } from "@/lib/auth";
import { getCompany } from "@/lib/services/company/get-company.service";
import { getBrandGuidelines } from "@/lib/services/company/get-brand-guidelines.service";
import { getBufferConnection } from "@/lib/services/buffer/get-buffer-connection.service";
import {
  listChannelConfigs,
  type ChannelConfigItem,
} from "@/lib/services/company/list-channel-configs.service";
import { DashboardLayout } from "@/components/dashboard/dashboard-layout";
import { CompanyWorkspaceHeader } from "@/components/company/company-workspace-header";
import { SetupChecklist } from "@/components/company/setup-checklist";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Section } from "@/components/ui/Section";
import { formatDateLong } from "@/lib/i18n/format-date";
import { resolveLegacyTabRedirect } from "@/lib/companies/legacy-tab-redirect";
import Link from "next/link";

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

  const [{ slug }, sp] = await Promise.all([params, searchParams]);

  // Until Phase 4a the workspace tabs were `?tab=` query parameters on this
  // page. Bookmarks and shared links still carry them, so they are translated
  // into their route here rather than silently landing on the overview.
  const legacyDestination = resolveLegacyTabRedirect(slug, sp);
  if (legacyDestination) redirect(legacyDestination);

  const company = await getCompany(slug, session.user.id, session.user.isGlobalAdmin);
  if (!company) notFound();

  const tNav = await getTranslations("navigation");

  const [brandGuidelines, bufferConnection, channelConfigs] = await Promise.all([
    getBrandGuidelines(company.id),
    getBufferConnection(company.id),
    listChannelConfigs(slug, session.user.id, session.user.isGlobalAdmin),
  ]);

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
        <CompanyWorkspaceHeader company={company} activeTab="overview" />

        <div className="mt-8">
          <OverviewTab
            company={company}
            slug={slug}
            brandGuidelines={brandGuidelines}
            bufferConnection={bufferConnection}
            channelConfigs={channelConfigs?.success ? channelConfigs.configs : []}
          />
        </div>
      </div>
    </DashboardLayout>
  );
}

// ── Overview tab ─────────────────────────────────────────────────────────────

interface OverviewTabProps {
  company: Awaited<ReturnType<typeof getCompany>>;
  slug: string;
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

  // The Approval card left in Phase 4c along with the tab — approving happens
  // on Posts now, and a card pointing at a filtered view of the card beside it
  // would be a third route to one page.
  const PRIMARY_CARDS = [
    {
      icon: Pencil,
      label: tWs("tabs.posts"),
      desc: tPage("modules.postsDesc"),
      href: `/companies/${slug}/posts`,
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
      href: `/companies/${slug}/sources`,
    },
    {
      icon: ClipboardList,
      label: tWs("tabs.activity"),
      desc: tPage("modules.auditLogDesc"),
      href: `/companies/${slug}/activity`,
    },
    {
      icon: Settings2,
      label: tWs("tabs.settings"),
      desc: tPage("modules.channelsDesc"),
      href: `/companies/${slug}/settings`,
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
