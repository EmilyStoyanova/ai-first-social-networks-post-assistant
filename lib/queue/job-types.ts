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

/** Post generation fan-out: generate/fill weekly schedules, auto-approve, publish, retry. */
export const POST_GENERATION_JOB_TYPE = "post-generation";

/**
 * Stable dedupe key for the single recurring post generation job. Same guarantee as
 * ingestion/translation: the partial unique index `jobs_dedupe_active_key` rejects a
 * second enqueue while one generation job is still queued or running, so overlapping
 * cron ticks can never create concurrent generation runs.
 *
 * This dedupe is one of three layers that keep concurrent runs from double-generating;
 * the others (the company-level CAS claim on `lastCronProcessedAt` and the unique index
 * on `Post.primaryFeedItemId`) live inside `runGenerationCron` and are unchanged.
 */
export const POST_GENERATION_DEDUPE_KEY = "cron:post-generation";

/** Publishing sweep: send every approved post that is due, across all companies. */
export const PUBLISH_SWEEP_JOB_TYPE = "publish-sweep";

/**
 * Stable dedupe key for the publishing sweep — the one that carries the most weight
 * of the four, because this job is the only thing that hands posts to Buffer.
 *
 * The sweep is triggered every 30 minutes by an external scheduler AND once a day by
 * the generation cron tick (the daily floor, see enqueue-generation-cycle.service.ts).
 * Two triggers plus a run that overruns its interval means overlapping enqueues are
 * expected, not exceptional. The partial unique index `jobs_dedupe_active_key`
 * (WHERE status IN ('queued','active')) rejects the second one, so a sweep already
 * queued or in flight absorbs every further request instead of a second sweep
 * starting, reading the same due posts, and delivering them to Buffer twice.
 *
 * Nothing is lost by the rejection: the sweep holds no per-tick state — it re-derives
 * what is due from `scheduledFor` every run — so the run already under way covers
 * exactly what the deduplicated one would have.
 */
export const PUBLISH_SWEEP_DEDUPE_KEY = "cron:publish-sweep";

/** Buffer analytics fan-out: refresh engagement metrics across all companies. */
export const ANALYTICS_SYNC_JOB_TYPE = "analytics-sync";

/**
 * Stable dedupe key for the recurring analytics job. Same guarantee as the others:
 * the partial unique index `jobs_dedupe_active_key` rejects a second enqueue while
 * one analytics job is still queued or running.
 *
 * It matters more here than elsewhere: this job is enqueued by the generation cron
 * tick AND can be triggered manually from /api/v1/internal/cron/analytics, so two
 * runs really can be asked for at once — and they would read the same stalest
 * posts twice, spending Buffer's daily allowance on duplicate requests.
 */
export const ANALYTICS_SYNC_DEDUPE_KEY = "cron:analytics-sync";
