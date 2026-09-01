/** Shared read shape + Prisma `select`, reused by list/create/update so all
 *  three return an identical DTO — the create/update responses are what the
 *  client-side list state is patched with (see the `content-sources-section`
 *  pattern this mirrors).
 *
 *  Deliberately does NOT select the collection-state columns
 *  (collectionEnabled/collectionMode/externalProfileId/lastCollectedAt/
 *  collectionStatus/collectionError) — every profile's value is the static
 *  schema default in Part 3A (nothing writes them yet), so there is nothing
 *  real to show. Exposing them now would risk the UI implying collection
 *  exists; Part 3C adds them to this DTO when there is an actual state to
 *  read. */

export interface CompetitorSocialProfileItem {
  id: string;
  platform: string;
  url: string;
  label: string | null;
}

export interface CompetitorListItem {
  id: string;
  name: string;
  country: string | null;
  website: string | null;
  notes: string | null;
  /** ISO timestamp, or null when the competitor is active. */
  archivedAt: string | null;
  socialProfiles: CompetitorSocialProfileItem[];
  createdAt: string;
  updatedAt: string;
}

export const COMPETITOR_SELECT = {
  id: true,
  name: true,
  country: true,
  website: true,
  notes: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
  socialProfiles: {
    select: { id: true, platform: true, url: true, label: true },
    orderBy: { createdAt: "asc" as const },
  },
} as const;

interface CompetitorRow {
  id: string;
  name: string;
  country: string | null;
  website: string | null;
  notes: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  socialProfiles: Array<{ id: string; platform: string; url: string; label: string | null }>;
}

export function toCompetitorItem(row: CompetitorRow): CompetitorListItem {
  return {
    id: row.id,
    name: row.name,
    country: row.country,
    website: row.website,
    notes: row.notes,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    socialProfiles: row.socialProfiles.map((p) => ({
      id: p.id,
      platform: p.platform,
      url: p.url,
      label: p.label,
    })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
