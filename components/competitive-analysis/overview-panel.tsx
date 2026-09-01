import { getTranslations } from "next-intl/server";
import { Users } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { ResearchProfileForm } from "./research-profile-form";
import type { ResearchProfileDTO } from "@/lib/services/competitive-analysis/get-research-profile-or-defaults.service";

interface Props {
  slug: string;
  profile: ResearchProfileDTO;
  isOwner: boolean;
  activeCompetitorCount: number;
}

/** Part 3A's Overview: an active-competitor count and the Research Profile.
 *  No aggregate/trend data exists yet (Part 3B) — nothing here is faked. */
export async function OverviewPanel({ slug, profile, isOwner, activeCompetitorCount }: Props) {
  const t = await getTranslations("competitiveAnalysis.overview");

  return (
    <div className="space-y-6">
      <Card className="flex items-center gap-3 px-5 py-4">
        <span className="bg-surface-subtle text-fg-muted flex h-10 w-10 shrink-0 items-center justify-center rounded-full">
          <Users className="h-5 w-5" aria-hidden="true" />
        </span>
        <div>
          <p className="text-fg text-xl font-semibold tabular-nums">{activeCompetitorCount}</p>
          <p className="text-fg-muted text-xs">{t("activeCompetitors")}</p>
        </div>
      </Card>

      {/* Keyed on `slug`: without it, switching the active company reuses this
          client component's instance (same tree position, same type) across
          the navigation and its local state — the topic/market tags being
          edited, the just-saved profile — would survive and render as though
          it belonged to the new company. Same reconciliation issue as Part 2's
          ContentCreationPanel; see that fix's comment for the full
          explanation. The server always hands down fresh `initialProfile`
          props either way — the key is what actually resets local state. */}
      <ResearchProfileForm key={slug} slug={slug} initialProfile={profile} isOwner={isOwner} />
    </div>
  );
}
