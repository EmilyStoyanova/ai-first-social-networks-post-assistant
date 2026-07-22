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

Translation, generation, image generation and manual generation are still on
their own cron routes — **not** migrated yet.

## Run

From the repo root (so the shared client and root `.env` resolve):

```bash
npx tsx worker/src/index.ts
```

## Configuration

| Env var                        | Default           | Meaning                              |
| ------------------------------ | ----------------- | ------------------------------------ |
| `DATABASE_URL`                 | — (required)      | Shared with the app                  |
| `WORKER_ID`                    | `hostname:pid`    | Stable worker identity               |
| `WORKER_CONCURRENCY`           | `1`               | Parallel jobs (recorded now; Phase 2) |
| `WORKER_POLL_INTERVAL_MS`      | `2000`            | Idle poll cadence                    |
| `WORKER_HEARTBEAT_INTERVAL_MS` | `15000`           | Heartbeat cadence                    |
| `WORKER_LEASE_TTL_MS`          | `300000`          | Job lease TTL (Phase 2 reaper)       |
| `WORKER_SHUTDOWN_GRACE_MS`     | `30000`           | Drain window before force-exit       |

## Tests

Run from the repo root with the rest of the suite (`npm test`).
