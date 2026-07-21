# v2-9 — Split cron architecture (scalable, two-pipeline)

## Problem

The single daily cron (`/api/v1/internal/cron` → `runCron`) processes **one company per
invocation**. With N companies each is processed ~once every N days. Ingestion and
generation were coupled, so RSS freshness was also gated by that rotation.

## Solution — two independent crons

The pipeline is split into two orchestrators that share the **same underlying step
services** (no business logic duplicated):

| Cron | Route | Service | Suggested schedule |
|------|-------|---------|--------------------|
| RSS ingestion | `/api/v1/internal/cron/ingest` | `runIngestionCron` | every 2h (`0 */2 * * *`) |
| Post generation | `/api/v1/internal/cron/generate` | `runGenerationCron` | hourly (`30 * * * *`) |

Both routes: `maxDuration = 60`, `force-dynamic`, `CRON_SECRET` auth (`verifyCronRequest`).
Both create a `CronRun` row and record `actionsTaken` (with a `kind` discriminator) for
diagnostics — identical to the old cron.

> The old combined route `/api/v1/internal/cron` (`runCron`) is **retained for manual /
> backwards-compatible invocation** but is **no longer scheduled**. It must not be
> scheduled alongside the generation cron — both advance `Company.lastCronProcessedAt`.

### Vercel Hobby note
Hobby plans cap crons at once/day. The 2h/hourly cadence assumes a Pro plan. On Hobby,
set both to daily and rely on the bounded-batch + fair-rotation design to catch up.

## Ingestion cron — `runIngestionCron`

Responsibilities: refresh stale sources across all companies, drain the translation
queue; **never generates posts**.

Execution order:
1. `createRun()` — CronRun (kind=`ingestion`).
2. **Phase A — ingest stale sources.** Select up to `MAX_SOURCES_PER_RUN` (25) enabled
   sources whose `lastFetchedAt` is null or older than `STALE_AFTER_MS` (6h), **oldest
   first** (`lastFetchedAt asc nulls first`, then `createdAt asc`). For each, until the
   soft time budget (`SOFT_TIME_BUDGET_MS` = 50s) is hit:
   - **Claim (lock):** compare-and-swap `updateMany({ where:{ id, lastFetchedAt: prev },
     data:{ lastFetchedAt: now } })`. `count===1` wins; `0` means a concurrent run already
     took it → counted as `sourcesClaimedElsewhere`, skipped. This is the concurrency
     guard.
   - **Ingest:** `runSourceIngestion(source, companyId)` (reused verbatim — parsing,
     dedup, translation-queueing, per-source `lastFetchedAt` stamp all unchanged).
   - **Failure isolation:** wrapped in try/catch; a throw is recorded in `sourceFailures`
     and the loop continues. Because the claim already advanced `lastFetchedAt`, a broken
     source is not retried until the next staleness window.
3. **Phase B — translations.** Select up to `MAX_TRANSLATION_COMPANIES_PER_RUN` (10)
   distinct companies with retry-due `pending`/`failed` translatable items, and run
   `translateFeedItems({ companyId })` per company (each internally bounded to
   `TRANSLATION_BATCH_SIZE`). Per-company try/catch → `translationFailures`. Skipped if
   already over budget.
4. `finishRun()` / on throw `failRun()` — records the summary in `actionsTaken`.

Fairness: oldest `lastFetchedAt` first + bounded batch ⇒ every source is revisited in
round-robin; unprocessed sources (budget/claim-lost) are simply picked next run.

## Generation cron — `runGenerationCron`

Responsibilities: generate/fill weekly schedules from **already-ingested** content,
auto-approve, publish, retry, backfill embeddings, sync metrics. Reuses the exact steps
3–8 of the old `runCron`.

Execution order:
1. `createRun()` — CronRun (kind=`generation`).
2. Select up to `MAX_COMPANIES_PER_RUN` companies **oldest first**
   (`lastCronProcessedAt asc nulls first`, then `createdAt asc`).
3. For each, until the soft time budget is hit:
   - **Claim (lock):** CAS `updateMany({ where:{ id, lastCronProcessedAt: prev },
     data:{ lastCronProcessedAt: now } })`. Loser → `companiesClaimedElsewhere`, skipped.
   - **Process (steps 3–8, unchanged):** `generateWeeklySchedule` → `autoApprovePosts` →
     `publishScheduledPosts` → `retryFailedPosts` → `backfillEmbeddings` →
     `syncPostMetrics`.
   - **Failure isolation:** per-company try/catch → `companyFailures`; batch continues.
4. `finishRun()` / `failRun()`.

Preserved behavior:
- **pending_approval / fully_automated** unchanged — `generateWeeklySchedule` still writes
  posts as `pending_approval`; `autoApprovePosts` promotes only fully-automated channels.
- **Content mix, schedules, channel policies, one-post-per-article** all live in
  `generateWeeklySchedule` / `generatePostFromContext` / the feed-item reservation, none
  of which changed.

### Why no duplicate generation across concurrent runs
1. Company-level CAS claim: two overlapping runs can't both process the same company.
2. `generateWeeklySchedule` is idempotent — upserts the week, counts existing posts per
   schedule, resumes.
3. `planFeedItemUsage` atomically reserves `usedInPost`, and the unique index on
   `Post.primaryFeedItemId` is the hard one-post-per-article guarantee.

## No schema change
Ingestion keys off the existing `ContentSource.lastFetchedAt`; generation off the existing
`Company.lastCronProcessedAt` (now used only by the generation cron). Both double as the
optimistic-lock version column.
