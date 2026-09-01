import { prisma } from "@/lib/db/client";
import { runSourceIngestion } from "@/lib/services/company/ingest-content-source.service";

/** Sources fetched within this window are considered fresh and skipped. */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export interface IngestCompanySourcesSummary {
  sourcesProcessed: number;
  sourcesSkipped: number;
  itemsCreated: number;
  itemsUpdated: number;
  failures: Array<{ sourceId: string; name: string; message: string }>;
}

export interface IngestableSourceRow {
  id: string;
  type: string;
  name: string;
  config: unknown;
  lastFetchedAt: Date | null;
}

export interface IngestCompanySourcesDeps {
  /** Injectable so the `competitorId: null` exclusion (verification pass §6)
   *  is pinned down as a regression test without a live database. */
  findSources?: (companyId: string) => Promise<IngestableSourceRow[]>;
  ingest?: typeof runSourceIngestion;
}

async function defaultFindSources(companyId: string): Promise<IngestableSourceRow[]> {
  return prisma.contentSource.findMany({
    where: { companyId, enabled: true, competitorId: null },
    select: { id: true, type: true, name: true, config: true, lastFetchedAt: true },
  });
}

/**
 * Cron step 2 — fetches new items from all enabled content sources of a
 * company whose lastFetchedAt is stale. Failures on individual sources are
 * collected, never thrown, so one broken RSS feed cannot stall the run.
 *
 * `competitorId: null` (verification pass §6) — a competitor's ContentSource
 * (`competitor_rss`/`competitor_website`, Part 3B) must be ingested ONLY
 * through the dedicated `ingest-competitor-source.service.ts` path, never
 * this one. Before this fix, this query had no such exclusion: every enabled
 * competitor source was included in the loop below and handed to the SHARED
 * `runSourceIngestion`, which has no matching branch for either competitor
 * type — so no FeedItem rows were actually written, but `lastFetchedAt` was
 * still unconditionally stamped (that write sits after the type dispatch, not
 * inside it), and the row was silently touched by a pipeline the architecture
 * says must never see it. This also mattered for defense in depth: had a
 * competitor-type branch ever been added to `runSourceIngestion` for an
 * unrelated reason, this gap would have turned into two independent paths
 * ingesting the same competitor feed.
 */
export async function ingestCompanySources(
  companyId: string,
  deps: IngestCompanySourcesDeps = {}
): Promise<IngestCompanySourcesSummary> {
  const findSources = deps.findSources ?? defaultFindSources;
  const ingest = deps.ingest ?? runSourceIngestion;
  const staleBefore = new Date(Date.now() - STALE_AFTER_MS);

  const sources = await findSources(companyId);

  const summary: IngestCompanySourcesSummary = {
    sourcesProcessed: 0,
    sourcesSkipped: 0,
    itemsCreated: 0,
    itemsUpdated: 0,
    failures: [],
  };

  for (const source of sources) {
    if (source.lastFetchedAt && source.lastFetchedAt > staleBefore) {
      summary.sourcesSkipped++;
      continue;
    }

    try {
      const { created, updated } = await ingest(source, companyId);
      summary.sourcesProcessed++;
      summary.itemsCreated += created;
      summary.itemsUpdated += updated;
    } catch (err) {
      summary.failures.push({
        sourceId: source.id,
        name: source.name,
        message: err instanceof Error ? err.message : "Unknown ingestion error.",
      });
    }
  }

  return summary;
}
