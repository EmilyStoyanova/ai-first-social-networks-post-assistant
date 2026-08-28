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

/**
 * How long to wait on the wake request before giving up on it.
 *
 * Three seconds is roughly four times what a healthy signal costs — a measured
 * TCP+TLS handshake to the Funnel ingress plus the round trip lands between 90ms
 * and 750ms, the upper end being a cold connection.
 *
 * It is deliberately NOT larger, and that is worth stating because it was once
 * raised to ten while a stall was being chased. The stall turned out to be a
 * suspended serverless sandbox rather than a slow network (see the scheduler
 * section at the foot of this file), so a bigger budget bought nothing — and it
 * costs something real: this runs inside `after()`, which shares the route's
 * function duration. The whole failure path is budget + DNS + probes, so ten
 * seconds here means up to 13.5s of deferred work on a route whose platform
 * default duration is around ten, i.e. an invocation killed before it can even
 * log why the wake failed.
 */
const WAKE_REQUEST_TIMEOUT_MS = 3_000;

/**
 * Budget for the post-mortem DNS lookup. Small on purpose: it runs only after a
 * delivery has ALREADY failed, so it is pure diagnosis and must never become a
 * second thing that hangs.
 */
const WAKE_DNS_TIMEOUT_MS = 1_000;

/**
 * Budget for each per-family connectivity probe.
 *
 * Generous enough that a HEALTHY path completes — a TLS handshake to a European
 * ingress from a US region is comfortably under this — because a probe that
 * times out on a working address would answer the wrong question. Both probes
 * run in parallel, so this is the total they can add, not twice it.
 */
const WAKE_PROBE_TIMEOUT_MS = 2_000;

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
  /** The budget that was configured, so `elapsedMs` can be read against it. */
  timeoutMs?: number;
  /**
   * When the abort signal actually fired, relative to the request start.
   *
   * The one measurement that splits a late abort from a late rejection. If this
   * lands on the budget but `elapsedMs` overshoots it, the timer was punctual and
   * the delay is downstream of it — teardown, or a promise that resumed late. If
   * this overshoots too, the timer itself was starved, and `cpuMs` says whether
   * that was because the process was busy or because it was not running at all.
   */
  abortAfterMs?: number;
  /**
   * CPU milliseconds consumed during the request (user + system).
   *
   * Distinguishes the two ways wall-clock time disappears on a serverless host.
   * CPU near the elapsed time means the event loop was saturated and timers were
   * starved. CPU near zero across a long elapsed time means the process was idle
   * — waiting on a socket, or frozen by the platform between the response and the
   * end of the deferred work.
   */
  cpuMs?: number;
  /** Present only on a transport failure that carried a usable `cause`. */
  cause?: WakeTransportCause;
  /** Present only on a transport failure — see `WakeDnsDiagnostic`. */
  dns?: WakeDnsDiagnostic;
  /** Per-family reachability, probed only after the real request has failed. */
  probes?: WakeProbes;
}

/**
 * One address, dialled directly, after the real request already failed.
 *
 * `fetch` picks an address for us and then tells us nothing about which one it
 * used. These probes take that decision back for the length of one measurement:
 * dial a known IPv4 and a known IPv6 and report each separately, so "the worker
 * is unreachable" and "the worker is unreachable OVER ONE FAMILY" stop looking
 * identical.
 */
export interface WakeProbeResult {
  address: string;
  /** 4 or 6. */
  family: number;
  /** True only if the probe got as far as `reached` says it should. */
  connected: boolean;
  elapsedMs: number;
  /** Milliseconds to complete the TCP handshake, when it completed at all. */
  tcpMs?: number;
  /**
   * How far the probe got. The whole diagnostic value is here: `"tcp"` present
   * at all means the address is ROUTABLE and something is listening, so a
   * failure after it is a TLS/Funnel problem, not a network one. No `tcpMs`
   * means the packets never landed — routing, filtering, or no route at all.
   */
  reached?: "tcp" | "tls";
  errorName?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface WakeProbes {
  ipv4?: WakeProbeResult;
  ipv6?: WakeProbeResult;
}

export interface WakeProbeTarget {
  address: string;
  family: number;
  port: number;
  /**
   * TLS server name. Set for an `https:` wake URL, absent for `http:`.
   *
   * Present means the probe completes a real TLS handshake with SNI, which is
   * what the Funnel routes on — a raw TCP connect to the ingress would prove
   * only that Tailscale's front door is up, not that it can find this tailnet.
   */
  servername?: string;
  timeoutMs: number;
}

export type WakeProbe = (target: WakeProbeTarget) => Promise<WakeProbeResult>;

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

/** Where a plan points, or undefined if the URL somehow no longer parses. */
function targetOf(
  url: string
): { hostname: string; port: number; servername?: string } | undefined {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname) return undefined;
    const secure = parsed.protocol === "https:";
    return {
      hostname: parsed.hostname,
      port: Number(parsed.port) || (secure ? 443 : 80),
      servername: secure ? parsed.hostname : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Dial one address in two explicit phases. Never throws, never outlives its budget.
 *
 * Split into TCP-then-TLS rather than one `tls.connect` so the two failure modes
 * cannot be confused. A single call that fails tells you only "it did not work";
 * connecting the socket first and upgrading it after means `tcpMs` is present
 * exactly when the address was reachable, which is the difference between a
 * routing fault and a handshake fault — and routing is the open question here.
 */
async function nodeProbe(): Promise<WakeProbe> {
  const [net, tls] = await Promise.all([import("node:net"), import("node:tls")]);

  return (target) =>
    new Promise<WakeProbeResult>((resolve) => {
      const started = Date.now();
      let tcpMs: number | undefined;
      let settled = false;

      const socket = net.connect({ host: target.address, port: target.port });
      let upgraded: import("node:tls").TLSSocket | undefined;

      const finish = (fields: Partial<WakeProbeResult>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // The OUTERMOST handle only, and this is not a style choice: destroying
        // a TLSSocket AND the raw socket it wraps segfaults Node (reproduced
        // 3/3, exit 0xC0000005). Destroying the TLSSocket tears down its
        // transport anyway, so one call closes everything.
        (upgraded ?? socket).destroy();
        resolve({
          address: target.address,
          family: target.family,
          connected: false,
          elapsedMs: Date.now() - started,
          ...(tcpMs !== undefined ? { tcpMs } : {}),
          ...fields,
        });
      };

      const fail = (err: unknown, phase: string) =>
        finish({
          connected: false,
          ...(tcpMs !== undefined ? { reached: "tcp" as const } : {}),
          errorName: typeof err === "object" && err !== null ? readString(err, "name") : undefined,
          errorCode: typeof err === "object" && err !== null ? readString(err, "code") : undefined,
          errorMessage: `${phase}: ${err instanceof Error ? err.message : String(err)}`,
        });

      // A hard backstop independent of the socket's own timeout, so a stall in
      // any phase — connect, TLS, or a listener that never fires — is bounded.
      const timer = setTimeout(
        () =>
          finish({
            connected: false,
            ...(tcpMs !== undefined ? { reached: "tcp" as const } : {}),
            errorName: "TimeoutError",
            errorMessage:
              tcpMs === undefined
                ? `no TCP handshake within ${target.timeoutMs}ms`
                : `TCP connected but no TLS handshake within ${target.timeoutMs}ms`,
          }),
        target.timeoutMs
      );
      if (typeof timer.unref === "function") timer.unref();

      socket.on("error", (err) => fail(err, "tcp"));
      socket.on("connect", () => {
        tcpMs = Date.now() - started;
        if (!target.servername) {
          finish({ connected: true, reached: "tcp" });
          return;
        }
        upgraded = tls.connect({ socket, servername: target.servername });
        upgraded.on("error", (err) => fail(err, "tls"));
        upgraded.on("secureConnect", () => finish({ connected: true, reached: "tls" }));
      });
    });
}

/**
 * Probe the first address of each family, in parallel. Never throws.
 *
 * Parallel because they are independent and the invocation is already over
 * budget by the time this runs — two sequential 2s probes would add four
 * seconds to a request that has nothing left to wait for.
 */
async function probeFamilies(
  target: { port: number; servername?: string },
  addresses: readonly WakeDnsAddress[],
  deps: DeliverWakeDeps
): Promise<WakeProbes | undefined> {
  const first = (family: number) => addresses.find((a) => a.family === family);
  const picks = [first(4), first(6)].filter((a): a is WakeDnsAddress => a !== undefined);
  if (picks.length === 0) return undefined;

  try {
    const probe = deps.probeImpl ?? (await nodeProbe());
    const timeoutMs = deps.probeTimeoutMs ?? WAKE_PROBE_TIMEOUT_MS;

    const settled = await Promise.all(
      picks.map(async (pick) => {
        try {
          return await withBudget(
            Promise.resolve(
              probe({
                address: pick.address,
                family: pick.family,
                port: target.port,
                servername: target.servername,
                timeoutMs,
              })
            ),
            // Slack over the probe's own budget: the probe is expected to police
            // itself, and this only catches one that does not.
            timeoutMs + 500
          );
        } catch (err) {
          return {
            address: pick.address,
            family: pick.family,
            connected: false,
            elapsedMs: timeoutMs,
            errorName: "ProbeError",
            errorMessage: err instanceof Error ? err.message : String(err),
          } satisfies WakeProbeResult;
        }
      })
    );

    const probes: WakeProbes = {};
    for (const result of settled) {
      if (result.family === 4) probes.ipv4 = result;
      if (result.family === 6) probes.ipv6 = result;
    }
    return Object.keys(probes).length > 0 ? probes : undefined;
  } catch {
    // The probe module would not even load. The wake failure is still the story.
    return undefined;
  }
}

export interface DeliverWakeDeps extends DescribeWakeDnsDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  probeImpl?: WakeProbe;
  probeTimeoutMs?: number;
}

/**
 * CPU time consumed so far, in milliseconds, where the runtime offers it.
 *
 * Read through `globalThis` rather than the `process` global so this module
 * stays loadable in a runtime that has no `process` at all.
 */
function readCpuMs(): number | undefined {
  const proc = (globalThis as { process?: { cpuUsage?: () => { user: number; system: number } } })
    .process;
  if (typeof proc?.cpuUsage !== "function") return undefined;
  try {
    const { user, system } = proc.cpuUsage();
    return (user + system) / 1000;
  } catch {
    return undefined;
  }
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
  const cpuStartedAt = readCpuMs();

  // Hoisted only to be observed. Created at the same point in the same order as
  // before, and the listener is passive — the request behaves identically.
  const signal = AbortSignal.timeout(timeoutMs);
  let abortedAt: number | undefined;
  signal.addEventListener("abort", () => void (abortedAt = now()), { once: true });

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
      signal,
    });
    return { ok: response.ok, status: response.status };
  } catch (err) {
    // Every measurement is taken before any diagnostic runs, so `elapsedMs`
    // reports the request and only the request. The diagnostics that follow
    // each report their own cost separately.
    const elapsedMs = now() - startedAt;
    const cpuEndedAt = readCpuMs();
    const cpuMs =
      cpuStartedAt !== undefined && cpuEndedAt !== undefined
        ? Math.round(cpuEndedAt - cpuStartedAt)
        : undefined;

    const cause = describeTransportError(err);
    const errorName = typeof err === "object" && err !== null ? readString(err, "name") : undefined;

    // Strictly after the failure, so nothing here can affect a delivery that was
    // going to work, and nothing on the success path pays for it.
    const target = targetOf(plan.url);
    const dns = target ? await describeWakeDns(target.hostname, deps) : undefined;
    const probes =
      target?.port && dns?.addresses?.length
        ? await probeFamilies(target, dns.addresses, deps)
        : undefined;

    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      // Omitted rather than set to undefined, so a field that had nothing to say
      // does not show up in the log as a key with no value.
      ...(errorName ? { errorName } : {}),
      elapsedMs,
      timeoutMs,
      ...(abortedAt !== undefined ? { abortAfterMs: abortedAt - startedAt } : {}),
      ...(cpuMs !== undefined ? { cpuMs } : {}),
      ...(cause ? { cause } : {}),
      ...(dns ? { dns } : {}),
      ...(probes ? { probes } : {}),
    };
  }
}

/** `IPv6 2a00:dd80:20::274` — family first, because family is the question. */
function formatAddress(entry: WakeDnsAddress): string {
  return `IPv${entry.family} ${entry.address}`;
}

function formatProbe(probe: WakeProbeResult): string {
  const who = `IPv${probe.family} ${probe.address}`;

  if (probe.connected) {
    const how = probe.reached === "tls" ? "TCP+TLS" : "TCP only";
    const tcp = probe.tcpMs !== undefined ? `, TCP handshake ${probe.tcpMs}ms` : "";
    return `${who} CONNECTED in ${probe.elapsedMs}ms (${how}${tcp})`;
  }

  // `tcpMs` present means the address is routable and something answered, so the
  // fault is above the network. Absent means the packets never arrived — with one
  // exception worth spelling out: a REFUSED connection also has no handshake, but
  // it proves the address is perfectly routable, which is the opposite reading.
  const phase =
    probe.tcpMs !== undefined
      ? `reachable (TCP in ${probe.tcpMs}ms) but TLS failed`
      : probe.errorCode === "ECONNREFUSED"
        ? "routable, but the port refused the connection"
        : "NO TCP — unreachable, filtered, or silently dropped";
  const why = [probe.errorCode, probe.errorName, probe.errorMessage].filter(Boolean).join(" ");
  return `${who} FAILED after ${probe.elapsedMs}ms — ${phase}${why ? `: ${why}` : ""}`;
}

/**
 * Flatten a failed delivery into something a log will actually print.
 *
 * This exists because of a concrete defect: `console.warn` formats objects with
 * `util.inspect` at depth 2, so `dns.addresses[i]` — three levels down — came
 * out of production as `[ [Object], [Object], [Object], … ]`. Six addresses were
 * captured and not one of them was readable, which is the entire diagnostic
 * lost to a formatting default.
 *
 * So nothing nested survives here. Addresses and probes become strings, which
 * `util.inspect` never truncates by depth, and the structured values stay on the
 * result for callers that want to branch on them.
 */
export function formatWakeFailure(result: WakeDeliveryResult): Record<string, unknown> {
  const line: Record<string, unknown> = {
    status: result.status,
    error: result.error,
  };

  if (result.errorName) line.errorName = result.errorName;
  if (result.elapsedMs !== undefined) line.elapsedMs = result.elapsedMs;
  if (result.timeoutMs !== undefined) line.timeoutMs = result.timeoutMs;
  if (result.abortAfterMs !== undefined) line.abortAfterMs = result.abortAfterMs;
  if (result.cpuMs !== undefined) line.cpuMs = result.cpuMs;
  // One level deep with scalar values — inside the depth limit, unlike `dns`.
  if (result.cause) line.cause = result.cause;

  if (result.dns) {
    line.dnsElapsedMs = result.dns.elapsedMs;
    if (result.dns.error) line.dnsError = result.dns.error;
    if (result.dns.addresses) line.dnsAddresses = result.dns.addresses.map(formatAddress);
  }

  if (result.probes?.ipv4) line.ipv4Probe = formatProbe(result.probes.ipv4);
  if (result.probes?.ipv6) line.ipv6Probe = formatProbe(result.probes.ipv6);

  return line;
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

/**
 * Where the installed scheduler lives: a slot on `globalThis`, not a binding in
 * this module.
 *
 * This is the fix for a real production defect, so it is worth being exact about
 * rather than reading as paranoia.
 *
 * `let scheduler = detachedScheduler` at module scope is correct in every mental
 * model where a module exists once. In the Turbopack build it does not. The
 * bundler MERGES this file into the chunk that `enqueue-job.service.ts` lives in
 * — the copy every route reaches through `enqueueJob` — and emits a SECOND,
 * standalone copy in the chunk `instrumentation.ts` dynamically imports. Two
 * copies, two `scheduler` bindings. `register()` installed the `after()` wrapper
 * on one of them; every enqueue in the application read the other, which had
 * never been assigned and so was still `detachedScheduler`.
 *
 * The consequence was invisible from here and expensive there: the wake fetch
 * ran as a dangling promise with nothing holding the invocation open, so Vercel
 * suspended the sandbox the moment the 202 was written — mid-TLS-handshake. The
 * request did not fail on the network. It failed because the process stopped
 * running: a 3000ms abort that fired at 5703ms, 62ms of CPU across 5.7 seconds
 * of wall clock, and a 2000ms probe timer that fired at 5433ms, all while TCP to
 * the ingress had completed in 96ms.
 *
 * A registered symbol is the one slot every copy of this module agrees on,
 * whatever the bundler does to the graph — which is exactly why Next.js hands
 * `waitUntil` across the same boundary the same way, through
 * `Symbol.for("@next/request-context")`.
 */
const SCHEDULER_SLOT: unique symbol = Symbol.for("app.queue.wake-scheduler");

interface SchedulerHost {
  [SCHEDULER_SLOT]?: WakeScheduler;
}

/** The host's scheduler if one was installed, else the detached default. */
function currentScheduler(): WakeScheduler {
  return (globalThis as SchedulerHost)[SCHEDULER_SLOT] ?? detachedScheduler;
}

/** Install the host's scheduler. Passing null restores the detached default. */
export function setWakeScheduler(next: WakeScheduler | null): void {
  const host = globalThis as SchedulerHost;
  if (next) host[SCHEDULER_SLOT] = next;
  else delete host[SCHEDULER_SLOT];
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

    (deps.scheduler ?? currentScheduler())(run);
  } catch {
    // Signalling is an optimisation; it does not get to break its caller.
  }
}
