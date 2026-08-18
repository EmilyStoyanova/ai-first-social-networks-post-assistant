import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { LineChart } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { ChannelsShell } from "@/components/company/channels-shell";
import { loadChannelsContext } from "../../context";

interface Props {
  params: Promise<{ slug: string; channel: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Channel analytics – ${slug} – AI-First Post Assistant` };
}

/**
 * Per-channel analytics — the navigation, without the feature behind it yet.
 *
 * Deliberately empty of everything but the message. The company already has
 * engagement metrics (v2-7), but they are per POST and read with a Buffer
 * Personal API Key that most companies have not configured; turning them into a
 * per-channel view is a real piece of work with its own decisions to make, not
 * something to approximate here. A placeholder that says so is honest; a chart
 * of whatever happens to be in `post_metrics` would not be.
 */
export default async function ChannelAnalyticsPage({ params }: Props) {
  const { slug, channel: channelParam } = await params;

  const context = await loadChannelsContext(slug, channelParam, "analytics");
  const { company, scopes, scope, user } = context;

  const t = await getTranslations("planner");

  return (
    <ChannelsShell
      company={company}
      user={{ name: user.name, email: user.email, isGlobalAdmin: user.isGlobalAdmin }}
      scopes={scopes}
      scope={scope}
      view="analytics"
    >
      <EmptyState icon={<LineChart className="h-5 w-5" />} title={t("analytics.comingSoon")} />
    </ChannelsShell>
  );
}
