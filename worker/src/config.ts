/**
 * Worker configuration, loaded and validated from the environment with Zod
 * (the same validator used across the app). Fails fast with a clear error when a
 * required variable is missing or a numeric knob is malformed.
 */

import os from "node:os";
import { z } from "zod";

const envSchema = z.object({
  // Reused from the app — the worker shares lib/db/client.ts.
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  // Stable identity. When absent, derived as `${hostname}:${pid}` so a single box
  // running one worker is self-naming; set it explicitly when running several.
  WORKER_ID: z.string().min(1).optional(),
  // How many jobs this worker may run in parallel (Phase 2). Recorded now so the
  // Worker row reflects intended capacity from the start.
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(1),
  // Idle poll cadence — how often the runner looks for work.
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
  // Heartbeat cadence — must be comfortably shorter than the lease TTL.
  WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  // Job lease TTL (Phase 2 reaper input). Carried here so all timing lives in one place.
  WORKER_LEASE_TTL_MS: z.coerce.number().int().positive().default(300_000),
  // Grace window for in-flight work to finish during shutdown before we force exit.
  WORKER_SHUTDOWN_GRACE_MS: z.coerce.number().int().nonnegative().default(30_000),
  /**
   * Wall-clock budget for ONE manual bulk-generation attempt.
   *
   * The reason this exists at all — and is far larger than the HTTP route's
   * 240s — is the whole point of moving bulk generation onto the queue: a
   * worker is not a request and has no function cap to lose a batch to. 30
   * minutes comfortably covers the largest request the form can make (10 topics
   * × 4 channels = 40 full generations) without ever being the thing that stops
   * a run; the per-slot check inside the service still stops cleanly and reports
   * `time_budget` if it ever were.
   *
   * It is a budget rather than no limit because the alternative is a hung
   * provider call holding a lease forever. Note that exceeding it is not a
   * failure: the run ends with the posts it wrote and an honest stop reason,
   * and the job COMPLETES.
   */
  WORKER_BULK_BUDGET_MS: z.coerce.number().int().positive().default(1_800_000),

  /**
   * How long the queue must stay empty before the worker goes DORMANT: stops
   * polling and closes its database connection.
   *
   * The whole point is that a serverless Postgres suspends its compute after a
   * few minutes without activity, and a 2-second claim poll resets that timer
   * forever. Polling more slowly does not help — anything under the suspend
   * threshold keeps it awake just as effectively — so the worker has to stop
   * entirely, not stop often.
   *
   * A minute of quiet before that happens keeps a burst of related jobs (an
   * ingestion enqueueing its translation, which enqueues its classification) on
   * the fast path, since each follow-up lands well inside the window.
   *
   * `0` disables dormancy and restores continuous polling.
   */
  WORKER_DORMANT_AFTER_MS: z.coerce.number().int().nonnegative().default(60_000),

  /**
   * How long the worker sleeps while DORMANT before waking to check the queue
   * regardless of whether anything signalled it.
   *
   * This is what makes the HTTP wake an optimisation rather than a dependency:
   * a signal that is dropped, blocked, or never sent costs at most one of these
   * intervals of latency, never a job. It must therefore stay comfortably under
   * the 90-minute window a manually scheduled post remains publishable for (see
   * `lib/scheduling/publish-window.ts`), which 30 minutes is.
   */
  WORKER_FALLBACK_POLL_MS: z.coerce.number().int().positive().default(1_800_000),

  /**
   * Periodic stale-lease reaping.
   *
   * `0` — the default — means reap on startup and at the start of each active
   * burst instead of on a timer. With a single worker that is complete: the only
   * lease this process could find expired is one IT abandoned by crashing, and
   * it cannot crash and keep polling. A timer would also be a recurring query,
   * which is exactly the thing dormancy exists to remove.
   *
   * Set a positive interval when running more than one worker, where a lease
   * abandoned by a DIFFERENT process needs recovering without waiting for this
   * one to restart or wake.
   */
  WORKER_REAP_INTERVAL_MS: z.coerce.number().int().nonnegative().default(0),

  /** Shared secret for the wake listener. Unset disables the listener entirely. */
  WORKER_WAKE_SECRET: z.string().optional(),
  /**
   * Loopback port for the wake listener. Bound to `WORKER_WAKE_HOST` only; the
   * tunnel (Tailscale Funnel) is what makes it reachable, so the socket itself
   * never faces the network.
   */
  WORKER_WAKE_PORT: z.coerce.number().int().positive().max(65_535).default(3_003),
  WORKER_WAKE_HOST: z.string().min(1).default("127.0.0.1"),
  /** Wake requests accepted per minute before the listener starts refusing. */
  WORKER_WAKE_MAX_PER_MINUTE: z.coerce.number().int().positive().default(60),
});

export interface WorkerConfig {
  workerId: string;
  hostname: string;
  pid: number;
  concurrency: number;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  leaseTtlMs: number;
  shutdownGraceMs: number;
  bulkBudgetMs: number;
  dormantAfterMs: number;
  fallbackPollMs: number;
  reapIntervalMs: number;
  wakeSecret: string | undefined;
  wakePort: number;
  wakeHost: string;
  wakeMaxPerMinute: number;
}

export function loadWorkerConfig(
  env: Record<string, string | undefined> = process.env
): WorkerConfig {
  const parsed = envSchema.parse(env);
  const hostname = os.hostname();
  const pid = process.pid;

  return {
    workerId: parsed.WORKER_ID ?? `${hostname}:${pid}`,
    hostname,
    pid,
    concurrency: parsed.WORKER_CONCURRENCY,
    pollIntervalMs: parsed.WORKER_POLL_INTERVAL_MS,
    heartbeatIntervalMs: parsed.WORKER_HEARTBEAT_INTERVAL_MS,
    leaseTtlMs: parsed.WORKER_LEASE_TTL_MS,
    shutdownGraceMs: parsed.WORKER_SHUTDOWN_GRACE_MS,
    bulkBudgetMs: parsed.WORKER_BULK_BUDGET_MS,
    dormantAfterMs: parsed.WORKER_DORMANT_AFTER_MS,
    fallbackPollMs: parsed.WORKER_FALLBACK_POLL_MS,
    reapIntervalMs: parsed.WORKER_REAP_INTERVAL_MS,
    // Normalised to undefined here so every consumer tests one thing rather than
    // each deciding for itself whether "" counts as configured.
    wakeSecret:
      parsed.WORKER_WAKE_SECRET && parsed.WORKER_WAKE_SECRET.length > 0
        ? parsed.WORKER_WAKE_SECRET
        : undefined,
    wakePort: parsed.WORKER_WAKE_PORT,
    wakeHost: parsed.WORKER_WAKE_HOST,
    wakeMaxPerMinute: parsed.WORKER_WAKE_MAX_PER_MINUTE,
  };
}
