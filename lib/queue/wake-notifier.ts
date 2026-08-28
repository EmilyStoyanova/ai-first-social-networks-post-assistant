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

/**
 * Budget for the post-mortem DNS lookup. Small on purpose: it runs only after a
 * delivery has ALREADY failed, so it is pure diagnosis and must never become a
 * second thing that hangs.
 */
const WAKE_DNS_TIMEOUT_MS = 1_000;

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

/** One address the resolver returned, in the order it returned it. */
export interface WakeDnsAddress {
  address: string;
  /** 4 or 6. The whole question, in one number. */
  family: number;
}

/**
 * What the resolver says about the wake host, captured after a failed delivery.
 *
 * The point is the ORDER. `fetch` connects to whatever the resolver lists first,
 * and a host with both A and AAAA records behaves completely differently
 * depending on which one that is — a caller with no IPv6 route gets an instant
 * ENETUNREACH, and one whose IPv6 packets are silently dropped gets a hang that
 * looks exactly like a dead worker. Neither is distinguishable from the error
 * alone, and both are distinguishable from this.
 */
export interface WakeDnsDiagnostic {
  elapsedMs: number;
  /** Resolver order preserved — index 0 is what the connection would have used. */
  addresses?: WakeDnsAddress[];
  /** Set instead of `addresses` when the lookup itself failed or ran out of time. */
  error?: string;
}

export interface WakeDeliveryResult {
  ok: boolean;
  status?: number;
  error?: string;
  /**
   * The error's constructor/DOM name — `TimeoutError`, `TypeError`, `AbortError`.
   *
   * Carries information the message does not. An abort and a connect failure are
   * different faults with different fixes, and `AbortSignal.timeout` rejects
   * with a `DOMException` whose ONLY distinguishing mark is this name: it has no
   * `code`, and no `cause` for `describeTransportError` to reach.
   */
  errorName?: string;
  /**
   * Wall-clock milliseconds spent on the request, on the failure path only.
   *
   * Deliberately wall clock rather than monotonic. On a serverless host the gap
   * between "we waited out the 3s budget" (≈3000) and "the sandbox was frozen
   * mid-request and thawed later" (arbitrarily large) is itself a diagnosis, and
   * only a clock that keeps running while the process does not can show it.
   */
  elapsedMs?: number;
  /** Present only on a transport failure that carried a usable `cause`. */
  cause?: WakeTransportCause;
  /** Present only on a transport failure — see `WakeDnsDiagnostic`. */
  dns?: WakeDnsDiagnostic;
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

/** Resolve a hostname to every address, in resolver order. */
export type WakeDnsLookup = (
  hostname: string
) => Promise<ReadonlyArray<{ address: string; family: number }>>;

/**
 * Imported lazily, inside the failure path, and never at module scope.
 *
 * `node:dns` is a Node-only builtin while this module is reachable from bundles
 * that are not — the Edge runtime boots the instrumentation file too. A dynamic
 * import keeps the dependency out of every graph that never fails a wake, which
 * is all of them on the happy path.
 */
async function nodeDnsLookup(): Promise<WakeDnsLookup> {
  const { lookup } = await import("node:dns/promises");
  // `verbatim` pins resolver order explicitly. It is the default from Node 17,
  // but the ORDER is the entire point of this probe, so it is not left implied.
  return (hostname) => lookup(hostname, { all: true, verbatim: true });
}

/**
 * Reject if `work` outlives `ms`.
 *
 * Both handlers are attached before the race can settle, so a lookup that
 * resolves or rejects after the budget has expired is already accounted for and
 * cannot surface as an unhandled rejection. The timer is unref'd so a pending
 * probe never holds a process open.
 */
function withBudget<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    if (typeof timer.unref === "function") timer.unref();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    );
  });
}

export interface DescribeWakeDnsDeps {
  lookupImpl?: WakeDnsLookup;
  now?: () => number;
  dnsTimeoutMs?: number;
}

/**
 * Ask the resolver what it would have handed the connection. Never throws.
 *
 * Total by construction — a resolver that fails, hangs, or returns something
 * unexpected produces a diagnostic saying so, because the caller is already
 * reporting a failure and a diagnostic that can fail is worse than none.
 */
export async function describeWakeDns(
  hostname: string,
  deps: DescribeWakeDnsDeps = {}
): Promise<WakeDnsDiagnostic> {
  const now = deps.now ?? Date.now;
  const startedAt = now();

  try {
    const lookupImpl = deps.lookupImpl ?? (await nodeDnsLookup());
    const entries = await withBudget(
      Promise.resolve(lookupImpl(hostname)),
      deps.dnsTimeoutMs ?? WAKE_DNS_TIMEOUT_MS
    );

    // Rebuilt field by field rather than passed through: the resolver's entries
    // are the only part of this diagnostic that comes from outside, and an
    // allow-list is the same defence used for the transport cause.
    const addresses: WakeDnsAddress[] = [];
    for (const entry of entries ?? []) {
      if (typeof entry !== "object" || entry === null) continue;
      const address = readString(entry, "address");
      const family = readNumber(entry, "family");
      if (address !== undefined && family !== undefined) addresses.push({ address, family });
    }

    return { elapsedMs: now() - startedAt, addresses };
  } catch (err) {
    return {
      elapsedMs: now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** The host a plan points at, or undefined if it somehow no longer parses. */
function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

export interface DeliverWakeDeps extends DescribeWakeDnsDeps {
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

  // One reading, used both to sign and to measure. The credential timestamp IS
  // the moment the request starts, so there is nothing to reconcile.
  const startedAt = now();
  const credentials = createWakeCredentials(plan.secret, startedAt);

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
    // Measured before the DNS probe, so `elapsedMs` reports the request and only
    // the request. The probe's own cost is reported separately, under `dns`.
    const elapsedMs = now() - startedAt;
    const cause = describeTransportError(err);
    const errorName = typeof err === "object" && err !== null ? readString(err, "name") : undefined;

    // Strictly after the failure, so nothing here can affect a delivery that was
    // going to work, and nothing on the success path pays for it.
    const host = hostnameOf(plan.url);
    const dns = host ? await describeWakeDns(host, deps) : undefined;

    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      // Omitted rather than set to undefined, so a field that had nothing to say
      // does not show up in the log as a key with no value.
      ...(errorName ? { errorName } : {}),
      elapsedMs,
      ...(cause ? { cause } : {}),
      ...(dns ? { dns } : {}),
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
