# Worker

External background-job worker for the app. Lives in the same repository and
imports the app's service layer and Prisma client directly (`@/lib/*`), so job
logic is never duplicated.

> **Architecture: the worker is an orchestrator only.** It owns queue
> management, claiming, orchestration, retries, diagnostics and persistence. It
> contains **no** AI/business logic — every job handler is a thin adapter that
> delegates to the existing services (text/image/embedding generation, Buffer).

## Phase 1 — infrastructure only

This phase ships the process skeleton **only**. The worker:

- loads + validates config from the environment (`config.ts`),
- registers itself in the `workers` table on startup (`registry.ts`),
- sends periodic heartbeats,
- runs a polling loop and reports `starting → idle → busy → draining → stopped`
  (`runner.ts`),
- shuts down cleanly on `SIGTERM` / `SIGINT`.

It does **not** yet claim or execute jobs, modify the cron routes, or enqueue
anything. The `claim` / `processJob` hooks in `index.ts` are deliberate no-ops
that Phase 2 fills in without changing the loop.

## Phase 2 — generic queue engine

Adds the queue engine, wired into the Phase 1 loop:

- **Atomic claiming** (`prisma-adapters.ts` → `createPrismaJobStore`): a single
  `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)` leases the
  highest-priority due job to this worker and bumps `attempts`. Backed by the
  partial index `jobs_claim_idx`.
- **Dispatch** (`handler-registry.ts` + `orchestrator.ts`): the orchestrator
  looks up a handler by `job.type` and runs it. An unknown type fails terminally.
- **Retries with backoff** (`backoff.ts`): a failed attempt is requeued with an
  exponential, jittered `run_at` until `attempts >= maxAttempts`, then fails.
- **Lease reaper**: on startup and on an interval, jobs whose lease expired
  (crashed worker) are requeued — or failed if attempts are exhausted.
- **Diagnostics/persistence**: every transition is written to the `jobs` row
  (`status`, `attempts`, `last_error`, `result`, `started_at`, `finished_at`).

Only a **dummy** handler (`dummy-handler.ts`, type `dummy`) is registered — it
echoes its payload and, on `{ "fail": true }`, throws to exercise retries. RSS
and generation are **not** migrated yet. Real handlers (thin adapters over the
existing services) arrive in Phase 3.

## Phase 3 — RSS ingestion migrated

The first real job type. `rss-ingestion-handler.ts` (type `rss-ingestion`) is a
**thin adapter**: it calls the existing `runIngestionCron` service unchanged, maps
its summary to compact job-result diagnostics (`processedSources`,
`successfulSources`, `failedSources`, `durationMs`, …), and re-throws on a
run-level failure so the queue's retry/terminal policy applies. No ingestion
logic moved into `worker/`; per-source failures stay isolated inside the service
(a completed run with `failedSources > 0` is not retried).

The `ingest` cron route (`app/api/v1/internal/cron/ingest`) no longer runs
ingestion inline — it authenticates as before, then enqueues **one** job via
`enqueueJob` (`lib/services/queue/enqueue-job.service.ts`) with a stable
`dedupeKey` (`cron:rss-ingestion`). The partial unique index
`jobs_dedupe_active_key` makes an overlapping cron tick return
`{ deduplicated: true }` instead of starting a second concurrent run.

## Phase 4 — RSS translation migrated

The second real job type, following the exact shape of Phase 3.
`rss-translation-handler.ts` (type `rss-translation`) is a **thin adapter**: it calls
the existing `runTranslationCron` service unchanged, maps its summary to compact
job-result diagnostics (`examinedCompanies`, `processedCompanies`, `failedCompanies`,
`translated`, `failed`, `skipped`, `remaining`, `durationMs`, `timedOut`), and re-throws
on a run-level failure so the queue's retry/terminal policy applies. No translation or
AI logic moved into `worker/`; per-company failures stay isolated inside the service
(a completed run with `failedCompanies > 0` is not retried).

The `translate` cron route (`app/api/v1/internal/cron/translate`) no longer runs
translation inline — it authenticates as before, then enqueues **one** job via
`enqueueJob` with a stable `dedupeKey` (`cron:rss-translation`). The same partial unique
index `jobs_dedupe_active_key` makes an overlapping cron tick return
`{ deduplicated: true }` instead of starting a second concurrent run.

## Phases 5–7 — generation, analytics and publishing migrated

The remaining cron fan-outs followed the same shape, each a thin adapter over the
service the cron route used to call inline:

| Handler                      | Type              | Delegates to        |
| ---------------------------- | ----------------- | ------------------- |
| `post-generation-handler.ts` | `post-generation` | `runGenerationCron` |
| `analytics-sync-handler.ts`  | `analytics-sync`  | `runAnalyticsCron`  |
| `publish-sweep-handler.ts`   | `publish-sweep`   | `runPublishCron`    |

**Every cron route in the app now only enqueues.** Nothing in the pipeline runs
without a live worker. The publishing sweep carries the most weight of the three:
it is the only path that hands posts to Buffer, and a manually scheduled post is
only publishable for 90 minutes after its slot — so a worker that is down does
not merely delay posts, past that window it strands them.

## Lease renewal and progress

Two engine capabilities that a long, resumable job needs and the original queue
did not have.

**Lease renewal.** A claimed job used to have to finish inside
`WORKER_LEASE_TTL_MS` or the reaper would requeue it mid-flight and a second
worker would run it again. This was observed in production on `rss-translation`
(`attempts` 2 and 3 with `last_error = "lease expired — requeued by reaper"`).
Idempotent jobs survived it; a job that writes posts and spends LLM credits would
not. The orchestrator now renews the lease at **a third** of the TTL for as long
as the handler runs — a third, not a half, so a merely-late renewal is not the
difference between holding the lease and losing it. `renewLease` is guarded on
`(id, lockedBy, status)`, so a worker whose lease was already reaped cannot take
it back from whoever now holds it; when that guard fails the loop cancels itself
and logs at error level.

**Progress.** `saveProgress` writes a partial `result` while a job runs, under
the same guard. Handlers reach it through the optional `reportProgress` on
`JobContext`. It is best-effort by contract and swallows everything: a handler
reporting how far it has got must never be the reason its work is lost.

Because requeueing on failure deliberately does **not** clear `result`, the
progress an attempt wrote survives into the next attempt — which is what makes a
job resumable rather than merely retryable. `JobRecord.result` carries it to the
handler; only that job type's handler knows what its own progress means.

## Manual multi-channel bulk generation

`bulk-generation-handler.ts` (type `bulk-generation`) is the one **interactive**
job — a person is waiting on it — and the one queued for arithmetic rather than
cadence. A topic written for three channels is three full generations, so ten
topics is thirty and ten topics across four channels is forty. No HTTP function
cap accommodates that, and a run killed by the cap is the worst outcome
available: the posts it already wrote **are** committed while the caller gets a
connection reset and never learns their ids.

It is still a thin adapter — it calls `bulkGeneratePosts` unchanged — and owns
only four things:

1. **Payload validation.** The Zod schema in `lib/queue/bulk-generation-payload.ts`
   is imported by both ends, so the instruction cannot drift between the route
   that writes it and the worker that reads it.
2. **Authorization at execution time.** `isGlobalAdmin` is deliberately _not_ in
   the payload: a job can sit in the queue across the moment someone's admin
   rights are revoked, so the handler re-reads it and the run is authorized
   against what is true when the posts are written. Company membership is checked
   per generation inside the service, as for every other caller.
3. **Resumption.** The payload carries a **plan** minted once at enqueue: the
   `batchId` stamped on every post, and one `contentGroupId` per topic. Neither
   can be minted worker-side — attempt 2 would mint different ones, and a retry
   would open a second content group beside every half-written one. `toResumeState`
   rebuilds what the previous attempt committed from its progress record, so a
   resumed run skips the channels that already exist. The load-bearing part is the
   **anchor**: the topic a half-written group settled on. Without it the channels
   still missing would each decide a topic of their own and the group would
   fragment into unrelated posts.
4. **The retry boundary.** A per-topic or per-channel generation failure is
   **data**, not an exception — the pool ran dry, a candidate stayed a duplicate,
   one channel's text was too long with its source link. The service reports each
   with a code and a reason, every post it did write is committed, and the handler
   **completes**: a partial batch, honestly described. Retrying those would be
   actively wrong (none are different a minute later, and each attempt spends real
   money to find that out again). What throws — and so reaches the retry policy —
   is a job-level fault: an unparseable payload, a requester who no longer exists,
   or a run that produced nothing at all.

`maxAttempts` is **3** rather than the queue default of 5, because every attempt
costs LLM credits. Dedupe is **per company** (`bulk-generation:<slug>`), unlike
the global cron keys: two concurrent batches at one company would draw on the
same article pool while each measured uniqueness against a history the other was
concurrently writing, while two different companies have nothing to contend over.
A rejected dedupe is **reported** to the caller as `ALREADY_RUNNING` (HTTP 409)
rather than treated as success — this request carries its own instructions, so
the run already in flight is not the run that was asked for.

Single-post manual generation is **not** migrated and stays a synchronous request
path, which it comfortably fits in.

## Run

From the repo root (so the shared client and root `.env` resolve):

```bash
npx tsx worker/src/index.ts
```

## Configuration

| Env var                        | Default        | Meaning                                          |
| ------------------------------ | -------------- | ------------------------------------------------ |
| `DATABASE_URL`                 | — (required)   | Shared with the app                              |
| `WORKER_ID`                    | `hostname:pid` | Stable worker identity; set it when running >1   |
| `WORKER_CONCURRENCY`           | `1`            | Parallel jobs                                    |
| `WORKER_POLL_INTERVAL_MS`      | `2000`         | Idle poll cadence                                |
| `WORKER_HEARTBEAT_INTERVAL_MS` | `15000`        | Heartbeat cadence; keep well under the lease TTL |
| `WORKER_LEASE_TTL_MS`          | `300000`       | Job lease TTL — renewed at ⅓ of it while running |
| `WORKER_SHUTDOWN_GRACE_MS`     | `30000`        | Drain window before force-exit                   |
| `WORKER_BULK_BUDGET_MS`        | `1800000`      | Budget for one bulk-generation attempt           |

These are also documented in `.env.example`. Every one but `DATABASE_URL` has a
working default, so an empty configuration is valid.

## Deployment

**The worker is a release prerequisite, and it is not currently deployed.** The
`workers` table has only ever held locally-run rows (`hostname:pid` of a
developer machine), which means the whole queued pipeline — ingestion,
translation, generation, publishing, analytics, and now bulk generation — runs
only while someone has `npm run worker` open. A permanent always-on process
(any host that can run Node with `DATABASE_URL`) is required before this is
relied on in production.

Operationally, two queries answer "is it alive?":

```sql
SELECT name, status, last_heartbeat_at FROM workers ORDER BY last_heartbeat_at DESC;
SELECT status, count(*), min(created_at), max(finished_at) FROM jobs GROUP BY status;
```

A stale `last_heartbeat_at` with a growing `queued` count is a dead worker.

## Tests

Run from the repo root with the rest of the suite (`npm test`).
