import { getTranslations } from "next-intl/server";
import { Rss } from "lucide-react";
import { formatDateTime } from "@/lib/i18n/format-date";
import { OverviewPanel } from "./overview-panel";

export interface OverviewSourceRow {
  id: string;
  name: string;
  host: string | null;
  enabled: boolean;
  newItemCount: number;
  lastFetchedAt: string | null;
}

interface Props {
  slug: string;
  sources: OverviewSourceRow[];
}

export async function OverviewSources({ slug, sources }: Props) {
  const t = await getTranslations("overview.sources");

  return (
    <OverviewPanel
      icon={Rss}
      title={t("title")}
      footerHref={`/companies/${slug}/sources`}
      footerLabel={t("viewAll")}
    >
      {sources.length === 0 ? (
        <p className="text-fg-faint py-8 text-center text-sm">{t("empty")}</p>
      ) : (
        <ul role="list" className="divide-border divide-y">
          {sources.map((source) => {
            const hasNew = source.newItemCount > 0;
            return (
              <li key={source.id} className="flex items-center gap-3 py-3 first:pt-0">
                <span
                  className="bg-tile-neutral-bg text-tile-neutral-fg rounded-control flex h-8 w-8 shrink-0 items-center justify-center"
                  aria-hidden="true"
                >
                  <Rss className="h-4 w-4" />
                </span>

                <div className="min-w-0 flex-1">
                  <p className="text-fg truncate text-sm font-medium">{source.name}</p>
                  {source.host && <p className="text-fg-faint truncate text-xs">{source.host}</p>}
                </div>

                {/* Text, not colour alone — the dot is a scanning aid on top of
                    a sentence, never the only carrier of the state (§11). */}
                <span
                  className={`inline-flex shrink-0 items-center gap-1.5 text-xs font-medium ${
                    hasNew ? "text-status-success-fg" : "text-fg-faint"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      hasNew ? "bg-status-success-dot" : "bg-status-neutral-dot"
                    }`}
                    aria-hidden="true"
                  />
                  {hasNew ? t("newContent", { count: source.newItemCount }) : t("noNewContent")}
                </span>

                <span className="text-fg-faint w-24 shrink-0 text-right text-xs tabular-nums">
                  {source.lastFetchedAt ? formatDateTime(source.lastFetchedAt) : t("neverFetched")}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </OverviewPanel>
  );
}
