/**
 * Job type identifiers and dedupe keys for the background queue.
 *
 * Pure constants with no dependencies, so both the Next app (enqueue side) and
 * the external worker (execute side) can import them without pulling in Prisma.
 * The `type` column is a plain string (see prisma/schema.prisma) — these are the
 * canonical values.
 */

/** RSS ingestion fan-out: refresh stale content sources across all companies. */
export const RSS_INGESTION_JOB_TYPE = "rss-ingestion";

/**
 * Stable dedupe key for the single recurring RSS ingestion job. Combined with the
 * partial unique index `jobs_dedupe_active_key` (WHERE status IN ('queued','active')),
 * a second enqueue while one ingestion job is still queued or running is rejected —
 * so overlapping cron ticks can never create concurrent ingestion runs.
 */
export const RSS_INGESTION_DEDUPE_KEY = "cron:rss-ingestion";

/** RSS translation fan-out: drain the pending-translation queue across all companies. */
export const RSS_TRANSLATION_JOB_TYPE = "rss-translation";

/**
 * Stable dedupe key for the single recurring RSS translation job. Same guarantee as
 * ingestion: the partial unique index `jobs_dedupe_active_key` rejects a second enqueue
 * while one translation job is still queued or running, so overlapping cron ticks can
 * never create concurrent translation runs.
 */
export const RSS_TRANSLATION_DEDUPE_KEY = "cron:rss-translation";
