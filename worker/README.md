# Worker

External background-job worker for the app. Lives in the same repository and
imports the app's service layer and Prisma client directly (`@/lib/*`), so job
logic is never duplicated.

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
