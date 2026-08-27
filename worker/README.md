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

## ACTIVE / DORMANT — why the worker stops polling

The queue lives on a serverless Postgres (Neon) whose compute suspends after a
few minutes without activity, and the original 2-second claim poll was activity
every two seconds — permanently. Not merely wasteful: it made scale-to-zero
structurally impossible, because suspension is triggered by a GAP with no query
in it, and any fixed poll interval shorter than the suspend threshold keeps
resetting that gap forever. **Slowing the poll down does not help** — a poll
every 60s resets the timer exactly as reliably as one every 2s, only less often.
Nothing short of not polling stops the clock.

So the worker has two states:

- **ACTIVE** — claiming every `WORKER_POLL_INTERVAL_MS`, same as before, until
  the queue has been empty for `WORKER_DORMANT_AFTER_MS`.
- **DORMANT** — the Prisma connection is explicitly closed
  (`prisma.$disconnect()`) and **zero** queries are sent. The worker waits for
  either an authenticated wake request or `WORKER_FALLBACK_POLL_MS`, whichever
  comes first, then reconnects (`prisma.$connect()`), reaps any stale leases,
  and resumes claiming until the queue drains again.

#### Nothing may be sequenced ahead of the wait

The fallback timer and the wake subscription are armed **before** the connection
is released, and this ordering is load-bearing rather than stylistic. It was
originally the other way around, and the disconnect turned out to be capable of
never returning: `$disconnect()` ends the Neon pool, and `Pool.end()` resolves
only once every checked-out client has been handed back — one leaked by a socket
that died mid-query never is. A worker that hit this logged `dormant` and then
went silent forever, with **no timer armed and no listener subscribed**,
recoverable only by a restart. Both wake paths were downstream of a call that
could hang, so both died together.

So the loop now constructs the wait first (synchronously — the timer is ticking
and the latch has its subscriber before the first `await`), and only then
releases the connection, bounded by `WORKER_DORMANT_CLEANUP_TIMEOUT_MS`.
Abandoning a disconnect costs one cycle of a connection that should have been
closed; abandoning the wait cost the entire queue. A wake arriving while the
disconnect is still stuck cancels the wait for it outright, since the next thing
the worker does is reconnect anyway — otherwise a permanently stuck pool would
add the full bound to every wake. The hook's eventual settlement is still
observed, so a late failure is logged rather than surfacing as an unhandled
rejection.

Postgres remains the only source of truth for what work exists. The wake signal
is a latency optimisation and nothing else — a dropped, blocked, or never-sent
signal costs at most one fallback interval, never a job. `enqueueJob`
(`lib/services/queue/enqueue-job.service.ts`) fires it, best-effort, strictly
**after** the job row is committed; see that file and
`lib/queue/wake-notifier.ts` for why a wake can never fail an enqueue, and for
why the worker process itself never sends one (`WORKER_PROCESS=1` — a worker
enqueueing its own follow-up is already ACTIVE and claims it on the next poll).

### The wake listener

`worker/src/wake-server.ts` runs one route, `POST /wake`, bound to
`WORKER_WAKE_HOST` (loopback by default — reachability is the tunnel's job, not
this socket's). It carries no job id, no payload, and no second route: the only
thing a valid request can mean is "look at the queue now", which the worker was
always going to do anyway on its fallback tick. That is what keeps the
authentication proportionate to what's actually at stake — the blast radius of a
forged request is one in-memory boolean flipped a few minutes early.

Requests are HMAC-SHA256 signed (`lib/security/wake-auth.ts`, shared by both
ends) over a version tag, a millisecond timestamp, and a single-use nonce —
never over anything request-specific, since there is nothing request-specific to
sign. A `WakeGuard` per worker process checks, in order: a fixed-window rate
limit (so flooding costs an integer increment, not an HMAC), a ±60s clock-skew
window, the signature (`timingSafeEqual`), then an in-memory replay cache keyed
by nonce. All of it lives in process memory — deliberately never in Postgres,
since a rate limiter that queried Neon would defeat the entire point by waking
the database to decide whether to wake the worker.

### Heartbeats and the reaper, revisited

**Heartbeats now run only while the worker is `busy`.** No code in this
repository reads `workers.last_heartbeat_at` outside a manual diagnostic query
(below); stale-lease detection is driven by each job's own `lease_expires_at`,
maintained independently by lease renewal. An idle heartbeat proved nothing
anyone consumed while costing a write every `WORKER_HEARTBEAT_INTERVAL_MS`,
forever — so `WorkerRegistry.setStatus` now starts/stops the timer with the
status transition instead of running it unconditionally from boot.

**The periodic reaper is off by default** (`WORKER_REAP_INTERVAL_MS=0`).
Stale-lease recovery instead runs once at process boot and once at the start of
every active burst (on waking, before the first claim). With the verified
single-worker deployment that is complete: the only lease this process could
find expired is one it abandoned by crashing, and a crashed process is not the
one that would be running the reaper. A **positive** `WORKER_REAP_INTERVAL_MS`
restores the old timer-based behaviour for a multi-worker deployment, where a
lease abandoned by a _different_ process needs recovering without waiting for
this one to wake or restart.

Lease renewal itself — the ⅓-of-TTL loop described above, under "Lease renewal
and progress" — is **unchanged**. It runs only while a job is held, was already
independent of the poll loop's cadence, and has nothing to do with dormancy.

## Run

From the repo root (so the shared client and root `.env` resolve):

```bash
npx tsx worker/src/index.ts
```

## Configuration

| Env var                             | Default        | Meaning                                                                         |
| ----------------------------------- | -------------- | ------------------------------------------------------------------------------- |
| `DATABASE_URL`                      | — (required)   | Shared with the app                                                             |
| `WORKER_ID`                         | `hostname:pid` | Stable worker identity; set it when running >1                                  |
| `WORKER_CONCURRENCY`                | `1`            | Parallel jobs                                                                   |
| `WORKER_POLL_INTERVAL_MS`           | `2000`         | Idle poll cadence                                                               |
| `WORKER_HEARTBEAT_INTERVAL_MS`      | `15000`        | Heartbeat cadence; keep well under the lease TTL                                |
| `WORKER_LEASE_TTL_MS`               | `300000`       | Job lease TTL — renewed at ⅓ of it while running                                |
| `WORKER_SHUTDOWN_GRACE_MS`          | `30000`        | Drain window before force-exit                                                  |
| `WORKER_BULK_BUDGET_MS`             | `1800000`      | Budget for one bulk-generation attempt                                          |
| `WORKER_DORMANT_AFTER_MS`           | `60000`        | Empty-queue quiet time before going DORMANT; `0` disables dormancy              |
| `WORKER_FALLBACK_POLL_MS`           | `1800000`      | Dormant wait ceiling — always recovers a missed wake within this                |
| `WORKER_DORMANT_CLEANUP_TIMEOUT_MS` | `10000`        | Bound on `$disconnect()` before the loop leaves it to finish on its own         |
| `WORKER_REAP_INTERVAL_MS`           | `0`            | Periodic reaper; `0` = burst-only (startup + each wake), correct for one worker |
| `WORKER_WAKE_SECRET`                | — (optional)   | Shared HMAC secret; unset disables the wake listener entirely                   |
| `WORKER_WAKE_PORT`                  | `3003`         | Loopback port the wake listener binds                                           |
| `WORKER_WAKE_HOST`                  | `127.0.0.1`    | Wake listener bind address — reachability is the tunnel's job                   |
| `WORKER_WAKE_MAX_PER_MINUTE`        | `60`           | In-memory rate limit on `/wake`, never Neon-backed                              |

These are also documented in `.env.example`. Every one but `DATABASE_URL` has a
working default, so an empty configuration is valid — with `WORKER_WAKE_SECRET`
unset the worker still runs correctly, just without the latency optimisation:
every job is picked up within `WORKER_POLL_INTERVAL_MS` while ACTIVE or within
`WORKER_FALLBACK_POLL_MS` after going DORMANT.

**On the Next app side**, `WORKER_WAKE_URL` (pointing at the worker's `/wake`,
reachable e.g. via a Tailscale Funnel) and the same `WORKER_WAKE_SECRET` make
`enqueueJob` signal the worker after every commit. Neither is required for
correctness — see "ACTIVE / DORMANT" above.

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
