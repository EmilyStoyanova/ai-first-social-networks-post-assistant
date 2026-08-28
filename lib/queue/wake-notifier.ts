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

/**
 * The transport-level detail behind a failed delivery.
 *
 * Exists because `fetch` is uninformative in exactly the case that matters.
 * undici reports EVERY connection-level failure — no route, refused, DNS,
 * timeout, TLS — as an Error whose message is the literal string
 * `"fetch failed"`, and puts the real fault in `cause`. Recording only the
 * message therefore turns "the network is unreachable over IPv6", "nothing is
 * listening", and "the certificate is wrong" into the same three words, which is
 * the difference between diagnosing a broken wake path and guessing at it.
 *
 * Every field is optional because `cause` is untyped by contract: it is whatever
 * the failing layer chose to attach, and different failures populate different
 * subsets.
 */
export interface WakeTransportCause {
  /** Constructor name, e.g. `Error`, `AggregateError`, `TypeError`. */
  name?: string;
  /** The libuv/undici code — `ENETUNREACH`, `ECONNREFUSED`, `ETIMEDOUT`, … */
  code?: string;
  message?: string;
  /** The failing call, e.g. `connect`, `getaddrinfo`. */
  syscall?: string;
  hostname?: string;
  address?: string;
  port?: number;
}

export interface WakeDeliveryResult {
  ok: boolean;
  status?: number;
  error?: string;
  /** Present only on a transport failure that carried a usable `cause`. */
  cause?: WakeTransportCause;
}

/** Read one property off an unknown value without asserting its shape. */
function read(source: object, key: string): unknown {
  return (source as Record<string, unknown>)[key];
}

function readString(source: object, key: string): string | undefined {
  const value = read(source, key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(source: object, key: string): number | undefined {
  const value = read(source, key);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Pull the transport fault out of an unknown error, safely.
 *
 * Deliberately an ALLOW-LIST of seven scalar fields rather than a serialisation
 * of `cause`. The error being described was produced while sending a signed
 * request, and a generic dump could reach a `request`/`options` object carrying
 * the very headers this module builds — the signature and the nonce. Naming the
 * fields means a future error shape can add whatever it likes without any of it
 * reaching a log.
 *
 * Follows one level of nesting (`cause.cause`) because undici wraps: the outer
 * error is the useless "fetch failed", its cause is often an `AggregateError`
 * whose own cause holds the syscall detail.
 */
export function describeTransportError(err: unknown): WakeTransportCause | undefined {
  if (typeof err !== "object" || err === null) return undefined;

  const direct = read(err, "cause");
  const candidates: unknown[] = [direct];

  // `AggregateError.errors` — what a multi-address connect attempt produces when
  // every address failed. The first is representative; they differ only by peer.
  if (typeof direct === "object" && direct !== null) {
    const errors = read(direct, "errors");
    if (Array.isArray(errors) && errors.length > 0) candidates.push(errors[0]);
    candidates.push(read(direct, "cause"));
  }

  const described = candidates.map((candidate) => {
    if (typeof candidate !== "object" || candidate === null) return undefined;

    const fields: WakeTransportCause = {
      name: readString(candidate, "name"),
      code: readString(candidate, "code"),
      message: readString(candidate, "message"),
      syscall: readString(candidate, "syscall"),
      hostname: readString(candidate, "hostname"),
      address: readString(candidate, "address"),
      port: readNumber(candidate, "port"),
    };

    // Drop the undefined keys so a log line shows only what was actually known.
    const populated = Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined)
    ) as WakeTransportCause;

    return Object.keys(populated).length > 0 ? populated : undefined;
  });

  // Two passes, and the order matters. An AggregateError sits at the head of the
  // chain carrying a summary message ("all attempts failed") and no code, while
  // the error that actually knows the syscall and the address is one of its
  // children — so a first-match-wins scan would consistently return the least
  // useful link. Prefer a candidate that names the fault; settle for a message.
  return (
    described.find((c) => c?.code || c?.syscall) ?? described.find((c) => c?.message) ?? undefined
  );
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
    const cause = describeTransportError(err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      // Omitted rather than set to undefined so the result stays deep-equal to
      // what it was for errors that carry nothing useful.
      ...(cause ? { cause } : {}),
    };
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
