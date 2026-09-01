import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/lib/auth";
import { getCompany } from "@/lib/services/company/get-company.service";
import { hasEnabledFeedItems } from "@/lib/services/company/list-feed-items.service";
import { listGenerationSources } from "@/lib/services/company/list-generation-sources.service";
import { listChannelConfigs } from "@/lib/services/company/list-channel-configs.service";
import { getContentMix } from "@/lib/services/company/get-content-mix.service";
import { resolveGenerationChannels } from "@/lib/posts/generation-channels";
import { DashboardLayout } from "@/components/dashboard/dashboard-layout";
import { ContentCreationPanel } from "@/components/company/content-creation-panel";
import { PageHeader } from "@/components/ui/PageHeader";

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Content Creation – ${slug} – AI-First Post Assistant` };
}

/**
 * The Content Creation module for one company (its own route root — see the
 * navigation plan's routing note). Real page, Part 2: hosts `GeneratePostForm`
 * with the exact generation-only data `/companies/[slug]/posts` used to fetch
 * for it, unchanged — this is a page-composition move, not a rewrite of
 * generation.
 *
 * Deliberately NOT `CompanyWorkspaceHeader` / the 8-tab company-management
 * bar — Content Creation is a task-oriented module, not a workspace tab.
 * Company context is already visible via the global header's company
 * selector (`DashboardLayout`'s `activeCompany`).
 */
export default async function ContentCreationPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const { slug } = await params;
  const company = await getCompany(slug, session.user.id, session.user.isGlobalAdmin);
  if (!company) notFound();

  const t = await getTranslations("contentCreation");

  const [rssFeedItemsAvailable, generationSources, channelConfigs, contentMixResult] =
    await Promise.all([
      hasEnabledFeedItems(company.id),
      listGenerationSources(slug, session.user.id, session.user.isGlobalAdmin),
      listChannelConfigs(slug, session.user.id, session.user.isGlobalAdmin),
      getContentMix(slug, session.user.id, session.user.isGlobalAdmin),
    ]);

  // An empty list simply leaves the dropdown with its two non-RSS choices.
  const generationSourceOptions = generationSources?.success ? generationSources.sources : [];
  // Only channels backed by an enabled Buffer profile can be generated for. An
  // empty list is a real state — the form says so and disables generation
  // rather than offering four channels the company never connected.
  const availableChannels = resolveGenerationChannels(
    channelConfigs?.success ? channelConfigs.configs : []
  );
  // Unreadable is treated as "no default to offer": the batch panel then
  // invites one to be set up, and generation behaves exactly as it did before
  // it existed.
  const contentMix = contentMixResult.success ? contentMixResult.mix : null;

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
        <PageHeader title={t("title")} description={t("description", { company: company.name })} />
        <ContentCreationPanel
          // Forces a full remount on every company switch. `page.tsx` re-runs on
          // navigation and hands down fresh props either way, but without a key
          // tied to the thing that actually changed, React reconciles this as
          // the SAME component instance at the SAME tree position — so its
          // local state (a just-generated result card, an in-flight bulk/topic
          // job reference, the form's own channel/source selection) would
          // survive the switch and render as if it belonged to the new company.
          // The keyed remount is what actually resets it; the props alone do not.
          key={slug}
          slug={slug}
          hasRssFeedItems={rssFeedItemsAvailable}
          contentSources={generationSourceOptions}
          availableChannels={availableChannels}
          // Narrowed here for the same reason the channels settings page does
          // it: the column is a free String in Prisma but only ever "en"/"bg".
          companyDefaultLang={company.defaultLang === "bg" ? "bg" : "en"}
          contentMix={contentMix}
        />
      </div>
    </DashboardLayout>
  );
}
