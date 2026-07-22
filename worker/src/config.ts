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
  };
}
