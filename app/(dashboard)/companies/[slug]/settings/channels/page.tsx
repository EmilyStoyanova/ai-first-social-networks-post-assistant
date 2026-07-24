import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/lib/auth";
import { getCompany } from "@/lib/services/company/get-company.service";
import { getBufferConnection } from "@/lib/services/buffer/get-buffer-connection.service";
import { listChannelConfigs } from "@/lib/services/company/list-channel-configs.service";
import { listContentSources } from "@/lib/services/company/list-content-sources.service";
import { getContentMix } from "@/lib/services/company/get-content-mix.service";
import { SettingsShell } from "@/components/company/settings-shell";
import { ChannelConfigSection } from "@/components/company/channel-config-section";
import { ContentMixSection } from "@/components/company/content-mix-section";
import { Section } from "@/components/ui/Section";

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Channels – ${slug} – AI-First Post Assistant` };
}

export default async function ChannelsSettingsPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const { slug } = await params;

  const company = await getCompany(slug, session.user.id, session.user.isGlobalAdmin);
  if (!company) notFound();

  const t = await getTranslations("companyPage");
  const canManage = company.role === "OWNER" || session.user.isGlobalAdmin;

  const [bufferConnection, channelConfigs, contentSources, contentMix] = await Promise.all([
    getBufferConnection(company.id),
    listChannelConfigs(slug, session.user.id, session.user.isGlobalAdmin),
    listContentSources(slug, session.user.id, session.user.isGlobalAdmin),
    getContentMix(slug, session.user.id, session.user.isGlobalAdmin),
  ]);

  const configs = channelConfigs?.success ? channelConfigs.configs : [];
  const sources = contentSources?.success ? contentSources.sources : [];
  const mix = contentMix?.success ? contentMix.mix : null;

  return (
    <SettingsShell
      company={company}
      user={{
        name: session.user.name,
        email: session.user.email,
        isGlobalAdmin: session.user.isGlobalAdmin,
      }}
      active="channels"
    >
      <div className="space-y-10">
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
            companyAutomationMode={company.automationMode ?? "semi_automated"}
            companyDefaultLang={company.defaultLang === "bg" ? "bg" : "en"}
          />
        </Section>

        {/* Content mix (v2-8) — a weekly quota policy, so it belongs with the
            cadence it divides rather than on the Sources page it reads from
            (§2.3). Hidden until a source exists: there is nothing to distribute
            otherwise, which is the same rule the Sources page applied. */}
        {mix && sources.length > 0 && (
          <ContentMixSection slug={slug} initialMix={mix} canManage={canManage} />
        )}
      </div>
    </SettingsShell>
  );
}
