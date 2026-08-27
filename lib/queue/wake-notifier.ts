/**
 * Telling the worker a job is waiting.
 *
 * The worker sleeps with the database connection closed when the queue has been
 * empty for a while, so nothing keeps Neon's compute awake. It still wakes on
 * its own schedule and would find any queued job there — Postgres remains the
 * only source of truth, and this file is not part of how a job gets run. It only
 * shortens the wait, which for a person watching a progress bar is the
 * difference between seconds and half an hour.
 *
 * Everything here is therefore best-effort by construction:
 *
 *   • it runs AFTER the job row is committed, never before;
 *   • it cannot fail an enqueue — every path swallows;
 *   • a dropped, refused, or forged-away signal costs latency, never a job.
 *
 * ── Why the scheduler is a seam ──────────────────────────────────────────────
 *
 * On Vercel the request's function may be frozen the moment the response is
 * sent, which would abandon a fetch started inline. `after()` exists for exactly
 * this and is the right primitive — but it belongs to `next/server` and throws
 * outside a request scope, and `enqueueJob` is ALSO called by four worker
 * handlers (ingestion, translation, classification, extraction) that enqueue
 * their own follow-ups in a plain Node process with no request and no Next.
 * Hardcoding `after()` in the enqueue path would break them.
 *
 * So the Next side installs its own scheduler at boot (`instrumentation.ts`) and
 * this module never imports `next/server`. A process that installs nothing —
 * the worker, a script, a test — gets the detached fallback, and the worker
 * gets no further than `planWakeNotification` anyway: it is already awake, and
 * a worker signalling itself through Vercel and back over the internet would be
 * a loop with a hop count.
 */

import { createWakeCredentials } from "@/lib/security/wake-auth";
import {
  WAKE_NONCE_HEADER,
  WAKE_SIGNATURE_HEADER,
  WAKE_TIMESTAMP_HEADER,
} from "@/lib/security/wake-auth";

/** How long to wait on the wake request before giving up on it. */
const WAKE_REQUEST_TIMEOUT_MS = 3_000;

/** The path the worker listens on. Appended when the configured URL omits it. */
const WAKE_PATH = "/wake";

export interface WakeNotifierEnv {
  /** "1" inside the worker process — see the file header. */
  WORKER_PROCESS?: string | undefined;
  /** Where the worker's wake listener is reachable. Unset disables signalling. */
  WORKER_WAKE_URL?: string | undefined;
  /** Shared secret; must match the worker's. Unset disables signalling. */
  WORKER_WAKE_SECRET?: string | undefined;
  /** Anything else `process.env` carries, so it can be passed in directly. */
  [key: string]: string | undefined;
}

export type WakePlan =
  | { deliver: false; reason: "worker-process" | "not-configured" | "invalid-url" }
  | { deliver: true; url: string; secret: string };

/**
 * Whether — and where — to signal, decided purely from the environment.
 *
 * Separate from delivery so the decision is testable without a socket, and so
 * "the worker must not signal itself" is a single readable branch rather than a
 * condition buried in a request builder.
 */
export function planWakeNotification(env: WakeNotifierEnv = process.env): WakePlan {
  if (env.WORKER_PROCESS === "1") return { deliver: false, reason: "worker-process" };

  const url = env.WORKER_WAKE_URL?.trim();
  const secret = env.WORKER_WAKE_SECRET?.trim();
  // Both or neither. A URL without a secret would mean sending unauthenticated
  // requests; a secret without a URL has nowhere to go.
  if (!url || !secret) return { deliver: false, reason: "not-configured" };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { deliver: false, reason: "invalid-url" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { deliver: false, reason: "invalid-url" };
  }
  // Tolerates both `https://host:10000` and `https://host:10000/wake` being
  // configured, so a deployment cannot silently POST to the wrong path.
  if (parsed.pathname === "" || parsed.pathname === "/") parsed.pathname = WAKE_PATH;

  return { deliver: true, url: parsed.toString(), secret };
}

export interface WakeDeliveryResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export interface DeliverWakeDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * Send one wake request. Never throws, never retries.
 *
 * No retry because the thing being asked for is idempotent and already has a
 * retry: the worker's fallback tick. A failed signal degrades to the behaviour
 * the system has when signalling is switched off entirely.
 */
export async function deliverWakeNotification(
  plan: Extract<WakePlan, { deliver: true }>,
  deps: DeliverWakeDeps = {}
): Promise<WakeDeliveryResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? WAKE_REQUEST_TIMEOUT_MS;

  const credentials = createWakeCredentials(plan.secret, now());

  try {
    const response = await fetchImpl(plan.url, {
      method: "POST",
      headers: {
        [WAKE_TIMESTAMP_HEADER]: String(credentials.timestamp),
        [WAKE_NONCE_HEADER]: credentials.nonce,
        [WAKE_SIGNATURE_HEADER]: credentials.signature,
        // Explicitly empty: the worker accepts no body, and saying so keeps a
        // proxy from inventing one.
        "content-length": "0",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: response.ok, status: response.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Runs a task without the caller waiting for it.
 *
 * Installed by `instrumentation.ts` on the Next side as a wrapper around
 * `after()`; left as the detached default everywhere else.
 */
export type WakeScheduler = (task: () => Promise<void>) => void;

function detachedScheduler(task: () => Promise<void>): void {
  void task().catch(() => {});
}

let scheduler: WakeScheduler = detachedScheduler;

/** Install the host's scheduler. Passing null restores the detached default. */
export function setWakeScheduler(next: WakeScheduler | null): void {
  scheduler = next ?? detachedScheduler;
}

export interface ScheduleWakeDeps extends DeliverWakeDeps {
  env?: WakeNotifierEnv;
  scheduler?: WakeScheduler;
  /** Called with the outcome, for logging in tests and diagnostics. */
  onResult?: (result: WakeDeliveryResult) => void;
}

/**
 * Fire-and-forget wake, safe to call from anywhere.
 *
 * Synchronous and total: it returns before any network work happens and cannot
 * throw, so a caller may invoke it on the success path of a write without
 * wrapping it or awaiting it.
 */
export function scheduleWakeNotification(deps: ScheduleWakeDeps = {}): void {
  try {
    const plan = planWakeNotification(deps.env ?? process.env);
    if (!plan.deliver) return;

    const run = async () => {
      const result = await deliverWakeNotification(plan, deps);
      deps.onResult?.(result);
    };

    (deps.scheduler ?? scheduler)(run);
  } catch {
    // Signalling is an optimisation; it does not get to break its caller.
  }
}
