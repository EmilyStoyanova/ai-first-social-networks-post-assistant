/** Shared read shape + Prisma `select` for a competitor's labeled RSS feed
 *  (a `ContentSource` row with `type: "competitor_rss"`). Mirrors
 *  `competitor-dto.ts`'s split. */

export interface CompetitorSourceItem {
  id: string;
  competitorId: string;
  /** The source's `name` column — the feed's label ("Blog", "News"). */
  label: string;
  url: string;
  enabled: boolean;
  lastFetchedAt: string | null;
  createdAt: string;
}

export const COMPETITOR_SOURCE_SELECT = {
  id: true,
  competitorId: true,
  name: true,
  config: true,
  enabled: true,
  lastFetchedAt: true,
  createdAt: true,
} as const;

interface CompetitorSourceRow {
  id: string;
  competitorId: string | null;
  name: string;
  config: unknown;
  enabled: boolean;
  lastFetchedAt: Date | null;
  createdAt: Date;
}

export function toCompetitorSourceItem(row: CompetitorSourceRow): CompetitorSourceItem {
  const config = row.config as { url?: string } | null;
  return {
    id: row.id,
    // Non-null by construction: only ever selected via a competitorId-scoped
    // query (see list/create/update-competitor-source.service.ts).
    competitorId: row.competitorId as string,
    label: row.name,
    url: config?.url ?? "",
    enabled: row.enabled,
    lastFetchedAt: row.lastFetchedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
