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

/**
 * Cron step 2 — fetches new items from all enabled content sources of a
 * company whose lastFetchedAt is stale. Failures on individual sources are
 * collected, never thrown, so one broken RSS feed cannot stall the run.
 */
export async function ingestCompanySources(
  companyId: string
): Promise<IngestCompanySourcesSummary> {
  const staleBefore = new Date(Date.now() - STALE_AFTER_MS);

  const sources = await prisma.contentSource.findMany({
    where: { companyId, enabled: true },
    select: { id: true, type: true, name: true, config: true, lastFetchedAt: true },
  });

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
      const { created, updated } = await runSourceIngestion(source, companyId);
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
