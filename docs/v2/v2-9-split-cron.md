# v2-9 — Split cron architecture (scalable, three-pipeline)

## Problem

The single daily cron (`/api/v1/internal/cron` → `runCron`) processes **one company per
invocation**. With N companies each is processed ~once every N days. Ingestion, translation
and generation were coupled, so RSS freshness was gated by that rotation — and a large
translation backlog (slow LLM calls) could consume the whole function budget before any
posts were generated.

## Solution — three independent crons

The pipeline is split into three orchestrators that share the **same underlying step
services** (no business logic duplicated):

| Cron            | Route                             | Service              | Schedule (Hobby: 1×/day) |
| --------------- | --------------------------------- | -------------------- | ------------------------ |
| RSS ingestion   | `/api/v1/internal/cron/ingest`    | `runIngestionCron`   | 05:00 UTC (`0 5 * * *`)  |
| Translation     | `/api/v1/internal/cron/translate` | `runTranslationCron` | 06:00 UTC (`0 6 * * *`)  |
| Post generation | `/api/v1/internal/cron/generate`  | `runGenerationCron`  | 07:00 UTC (`0 7 * * *`)  |

The order matters: ingest fetches fresh articles, translate drains the queue those articles
created, generate then draws from already-translated content. Each is an hour apart so a
slow stage can overrun without colliding with the next.

Routes:

- **ingest / translate / generate:** `maxDuration = 300` (Vercel Hobby + **Fluid Compute**),
  internal soft deadline **240s** (~60s headroom). All three do slow network/LLM/image work.
- All: `force-dynamic`, `CRON_SECRET` auth (`verifyCronRequest`), create a `CronRun` row and
  record `actionsTaken` (with a `kind` discriminator) for diagnostics.

> **Fluid Compute must be enabled** in the Vercel project (Settings → Functions) for the
> routes to actually get `maxDuration = 300` on Hobby — the default cap is 60s. On by default
> for projects created since early 2025; older projects must toggle it on.

> The old combined route `/api/v1/internal/cron` (`runCron`) is **retained for manual /
> backwards-compatible invocation** but is **no longer scheduled**. It must not be scheduled
> alongside the generation cron — both advance `Company.lastCronProcessedAt`.

### Vercel Hobby note

Hobby plans cap each cron at once/day, so all three run daily and rely on the bounded-batch +
fair-rotation design to catch up over successive days. On Pro these can be raised to the
originally intended cadence (ingest every 2h, translate hourly, generate hourly) with no code
change — only the `schedule` strings in `vercel.json`.

## Ingestion cron — `runIngestionCron`

Responsibilities: refresh stale sources across all companies — feed fetch, article
extraction, feed-item upserts. **Never translates and never generates posts.**

Execution order:

1. `createRun()` — CronRun (kind=`ingestion`).
2. Select up to `MAX_SOURCES_PER_RUN` (25) enabled sources whose `lastFetchedAt` is null or
   older than `STALE_AFTER_MS` (6h), **oldest first** (`lastFetchedAt asc nulls first`, then
   `createdAt asc`). For each, until the soft time budget (`SOFT_TIME_BUDGET_MS` = 240s) is
   hit:
   - **Claim (lock):** compare-and-swap `updateMany({ where:{ id, lastFetchedAt: prev },
data:{ lastFetchedAt: now } })`. `count===1` wins; `0` means a concurrent run already took
     it → counted as `skipped`. This is the concurrency guard.
   - **Ingest:** `runSourceIngestion(source, companyId, { shouldStop })` (reused verbatim —
     parsing, dedup, translation-**queueing**, per-source `lastFetchedAt` stamp unchanged).
     `shouldStop` lets one large feed stop between items at the deadline.
   - **Failure isolation:** wrapped in try/catch; a throw is recorded in `sourceFailures` and
     the loop continues.
3. `finishRun()` / on throw `failRun()` — records the summary (incl. per-phase `timings`) in
   `actionsTaken`.

Fairness: oldest `lastFetchedAt` first + bounded batch ⇒ round-robin; unprocessed sources
(budget/claim-lost) are picked next run. `timedOut` is set only when a still-stale source is
abandoned at the deadline — not merely because the clock passed it with nothing left.

## Translation cron — `runTranslationCron`

Responsibilities: drain the RSS translation queue that ingestion filled. Reuses
`translateFeedItems` **verbatim** — no translation logic is duplicated. Never ingests, never
generates posts.

Execution order:

1. `createRun()` — CronRun (kind=`translation`).
2. Select up to `MAX_TRANSLATION_COMPANIES_PER_RUN` (10) distinct companies with retry-due
   `pending`/`failed` translatable items, **oldest queued item first** (`createdAt asc`), so
   companies are revisited in a stable round-robin. For each, until the soft budget (240s):
   - **Translate:** `translateFeedItems({ companyId, shouldStop })` — internally bounded to
     `TRANSLATION_BATCH_SIZE`. `shouldStop` is checked **before every item**, so a large
     backlog stops between LLM calls instead of running to the timeout.
   - **Failure isolation:** per-company try/catch → `failures`; batch continues.
3. `finishRun()` / `failRun()` — records the summary (kind, `companiesExamined`,
   `companiesProcessed`, `translated`, `failed`, `skipped`, `remaining`, `durationMs`,
   `timings`, `failures`, `timedOut`) in `actionsTaken`.

### Continuation & retryability (no double-processing, nothing lost)

- An item is marked `translated` only when it **actually** is; anything left `pending`/
  `failed` (deadline, batch cap, or a transient failure) is simply re-selected next run.
- The existing **retry/backoff** (`translationAttemptCount`, `translationNextRetryAt`,
  `MAX_TRANSLATION_ATTEMPTS`) and the **translated/original fallback** are untouched — the
  cron only orchestrates the reused service.
- `remaining` is a live count of still-eligible items, the backlog the next run will pick up.

## Generation cron — `runGenerationCron`

Responsibilities: generate/fill weekly schedules from **already-ingested, already-translated**
content, auto-approve, publish, retry, backfill embeddings, sync metrics. Reuses the exact
steps 3–8 of the old `runCron`.

Execution order:

1. `createRun()` — CronRun (kind=`generation`).
2. Select up to `MAX_COMPANIES_PER_RUN` (5) companies **oldest first**
   (`lastCronProcessedAt asc nulls first`, then `createdAt asc`). The real limiter is the soft
   time budget (`SOFT_TIME_BUDGET_MS` = 240s), not this cap — a company can make several
   LLM/image calls, so throughput comes from the 300s window + `shouldStop`, not a big batch.
3. For each, until the soft time budget is hit:
   - **Claim (lock):** CAS `updateMany({ where:{ id, lastCronProcessedAt: prev },
data:{ lastCronProcessedAt: now } })`. Loser → `skipped` (the locking signal).
   - **Process (steps 3–8, unchanged):** `generateWeeklySchedule` → `autoApprovePosts` →
     `publishScheduledPosts` → `retryFailedPosts` → `backfillEmbeddings` → `syncPostMetrics`.
     `shouldStop` is threaded into `processCompany`: it goes into `generateWeeklySchedule` (the
     LLM/image loop stops **between posts** at the deadline) and is checked between the later
     steps, so a company crossing the budget defers its remaining maintenance steps to the
     next run instead of overrunning the function cap. Every step is idempotent, so deferring
     loses nothing.
   - **Failure isolation:** per-company try/catch → `companyFailures`; batch continues.
4. `finishRun()` / `failRun()` — records the summary (kind, `examined`, `processed`, `failed`,
   `skipped`, `remaining`, `durationMs`, `timings`, `companies`, `companyFailures`, `timedOut`)
   in `actionsTaken`.

### Continuation & the soft deadline

- **Between companies:** the deadline is checked before each claim; an unclaimed company is
  left for the next run (`timedOut` set only when a still-pending company is abandoned).
- **Within a company:** `generateWeeklySchedule` checks `shouldStop` before every post's
  expensive generation and stops between posts; the schedule stays `generating` and resumes.
- `remaining` counts companies not yet touched this cycle (`lastCronProcessedAt` null or before
  this run's start) — the backlog the next run picks up.

### Guaranteeing a response before the hard cap (v2-9 hardening)

A soft, cooperative deadline (`shouldStop`) cannot interrupt a `fetch` that is **already in
flight**. In production the generation cron still hit `FUNCTION_INVOCATION_TIMEOUT` — exactly
5 minutes, connection reset, no JSON — because the LLM providers (Groq/OpenAI/Anthropic) had
**no request timeout at all**, and the worker/embedding/Cloudinary/Buffer timeouts were fixed
constants (120s/180s/60s/…) unrelated to the remaining budget. One hung or late call ran past
the 300s cap and the function never returned.

Two more layers now enforce the deadline out-of-band ([lib/http/request-deadline.ts](../../lib/http/request-deadline.ts)):

1. **Ambient per-request deadline.** While a company is processed, an `AsyncLocalStorage`
   deadline is installed. Every outbound call (`requestSignal(cap)`) gets an `AbortSignal`
   timed to `min(per-request cap, time left to the 240s deadline)` — so no single LLM, image,
   Cloudinary, Buffer, or embedding call can consume the remaining headroom, and a call
   started with no budget left aborts immediately. Outside the cron it is a no-op, so the
   interactive path keeps its generous timeouts.
2. **Out-of-band race.** Each company is raced (`raceWithTimeout`) against a real timer at the
   deadline. Even a call that ignores its signal cannot hold the response: the company is
   abandoned, `timedOut=true`, the CronRun is still persisted, and the run returns — leaving
   the ~60s reserve (240s → 300s) for that persistence and the HTTP response.

The same ambient context accumulates **per-phase timings** (`recordPhase`) — `weeklyGeneration`,
`llm`, `image`, `approval`, `publishing`, `retry`, `backfill`, `analyticsSync` — surfaced in
`timings` alongside `companySelection`, `databaseWrites`, `cleanup`, and `total`.

Preserved behavior:

- **pending_approval / fully_automated** unchanged — `generateWeeklySchedule` still writes
  posts as `pending_approval`; `autoApprovePosts` promotes only fully-automated channels.
- **Content mix, schedules, channel policies, one-post-per-article** all live in
  `generateWeeklySchedule` / `generatePostFromContext` / the feed-item reservation, none of
  which changed.

### Why no duplicate generation across concurrent runs

1. Company-level CAS claim: two overlapping runs can't both process the same company.
2. `generateWeeklySchedule` is idempotent — upserts the week, counts existing posts per
   schedule, resumes.
3. `planFeedItemUsage` atomically reserves `usedInPost`, and the unique index on
   `Post.primaryFeedItemId` is the hard one-post-per-article guarantee.

## No schema change

Ingestion keys off the existing `ContentSource.lastFetchedAt`; generation off the existing
`Company.lastCronProcessedAt` (now used only by the generation cron); translation off the
existing `FeedItem` translation columns (`translationStatus`, `translationAttemptCount`,
`translationNextRetryAt`). No per-company lock is needed for translation: work is idempotent
by item status and deduped by translation hash, so an overlapping run cannot lose or
double-commit an item.
