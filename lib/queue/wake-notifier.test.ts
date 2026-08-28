/**
 * The signalling side.
 *
 * Three properties carry the whole design here, and each has its own section
 * below:
 *
 *   1. the worker never signals ITSELF — four job handlers enqueue follow-ups
 *      from inside the worker process, and a round trip through Vercel and back
 *      over a tunnel to reach a process that is already awake would be absurd;
 *   2. a signal is best-effort in the strongest sense — no configuration, a
 *      refused connection, a timeout, a 500, a scheduler that throws: all of it
 *      is silence, never an exception reaching the caller;
 *   3. what goes on the wire is a signed, timestamped, single-use credential and
 *      nothing else.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";

import {
  planWakeNotification,
  deliverWakeNotification,
  describeWakeDns,
  formatWakeFailure,
  scheduleWakeNotification,
  setWakeScheduler,
  type WakeDnsLookup,
  type WakeNotifierEnv,
  type WakeProbe,
} from "./wake-notifier";
import {
  WAKE_NONCE_HEADER,
  WAKE_SIGNATURE_HEADER,
  WAKE_TIMESTAMP_HEADER,
  WakeGuard,
} from "@/lib/security/wake-auth";

const SECRET = "shared-secret-for-tests";
const configured: WakeNotifierEnv = {
  WORKER_WAKE_URL: "https://worker.example.ts.net:10000/wake",
  WORKER_WAKE_SECRET: SECRET,
};

/** A fetch that records what it was asked to send and answers 202. */
function recordingFetch(status = 202) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

/**
 * A resolver stub.
 *
 * EVERY test that exercises a failed delivery must pass one. The failure path
 * now runs a DNS probe, and a test that omitted it would make a real network
 * query — for a hostname that does not exist — from the unit suite.
 */
function stubLookup(addresses: Array<{ address: string; family: number }> = []): WakeDnsLookup {
  return async () => addresses;
}

/**
 * A connectivity probe stub. Needed by any test whose resolver returns an
 * address, for the same reason as `stubLookup` — the real probe opens a socket.
 */
function stubProbe(connected = false): WakeProbe {
  return async (target) => ({
    address: target.address,
    family: target.family,
    connected,
    elapsedMs: 1,
    ...(connected ? { tcpMs: 1, reached: "tls" as const } : { errorName: "TimeoutError" }),
  });
}

/** Runs scheduled tasks immediately and hands back their promise. */
function immediateScheduler() {
  const tasks: Array<Promise<void>> = [];
  return {
    settle: () => Promise.all(tasks),
    scheduler: (task: () => Promise<void>) => {
      tasks.push(task());
    },
  };
}

// ─── Deciding whether to signal at all ────────────────────────────────────────

describe("planWakeNotification", () => {
  it("signals when a URL and a secret are both configured", () => {
    const plan = planWakeNotification(configured);
    assert.equal(plan.deliver, true);
    if (plan.deliver) assert.equal(plan.secret, SECRET);
  });

  it("does not signal from inside the worker process", () => {
    // The load-bearing case. `enqueueJob` is called by rss-ingestion,
    // rss-translation, rss-classification and product-page-extraction handlers
    // to queue their follow-ups; the worker running them is by definition awake
    // and will claim those jobs on its very next poll.
    const plan = planWakeNotification({ ...configured, WORKER_PROCESS: "1" });
    assert.deepEqual(plan, { deliver: false, reason: "worker-process" });
  });

  it("does not signal with a URL but no secret", () => {
    const plan = planWakeNotification({ WORKER_WAKE_URL: configured.WORKER_WAKE_URL });
    assert.deepEqual(plan, { deliver: false, reason: "not-configured" });
  });

  it("does not signal with a secret but no URL", () => {
    const plan = planWakeNotification({ WORKER_WAKE_SECRET: SECRET });
    assert.deepEqual(plan, { deliver: false, reason: "not-configured" });
  });

  it("does not signal when nothing is configured", () => {
    assert.deepEqual(planWakeNotification({}), { deliver: false, reason: "not-configured" });
  });

  it("treats whitespace-only configuration as absent", () => {
    const plan = planWakeNotification({ WORKER_WAKE_URL: "   ", WORKER_WAKE_SECRET: "  " });
    assert.deepEqual(plan, { deliver: false, reason: "not-configured" });
  });

  it("appends /wake when the configured URL is a bare origin", () => {
    const plan = planWakeNotification({
      ...configured,
      WORKER_WAKE_URL: "https://worker.example.ts.net:10000",
    });
    assert.equal(plan.deliver && plan.url, "https://worker.example.ts.net:10000/wake");
  });

  it("leaves an explicit path alone", () => {
    const plan = planWakeNotification(configured);
    assert.equal(plan.deliver && plan.url, "https://worker.example.ts.net:10000/wake");
  });

  it("refuses a malformed URL rather than throwing on it", () => {
    const plan = planWakeNotification({ ...configured, WORKER_WAKE_URL: "not a url" });
    assert.deepEqual(plan, { deliver: false, reason: "invalid-url" });
  });

  it("refuses a non-HTTP scheme", () => {
    const plan = planWakeNotification({ ...configured, WORKER_WAKE_URL: "file:///etc/passwd" });
    assert.deepEqual(plan, { deliver: false, reason: "invalid-url" });
  });
});

// ─── What actually goes on the wire ───────────────────────────────────────────

describe("deliverWakeNotification", () => {
  const plan = { deliver: true as const, url: configured.WORKER_WAKE_URL!, secret: SECRET };

  it("POSTs signed credentials and no body", async () => {
    const { calls, impl } = recordingFetch();
    const result = await deliverWakeNotification(plan, { fetchImpl: impl });

    assert.deepEqual(result, { ok: true, status: 202 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.body, undefined, "nothing is sent but the headers");

    const headers = calls[0].init.headers as Record<string, string>;
    assert.ok(headers[WAKE_TIMESTAMP_HEADER]);
    assert.ok(headers[WAKE_NONCE_HEADER]);
    assert.ok(headers[WAKE_SIGNATURE_HEADER]);
    assert.equal(headers["content-length"], "0");
  });

  it("sends credentials the worker's own guard accepts", async () => {
    // End to end across the two sides that must agree, without a socket.
    const { calls, impl } = recordingFetch();
    await deliverWakeNotification(plan, { fetchImpl: impl });
    const headers = calls[0].init.headers as Record<string, string>;

    const guard = new WakeGuard({ secret: SECRET });
    assert.equal(
      guard.verify({
        timestamp: headers[WAKE_TIMESTAMP_HEADER],
        nonce: headers[WAKE_NONCE_HEADER],
        signature: headers[WAKE_SIGNATURE_HEADER],
      }),
      "authorized"
    );
  });

  it("mints a fresh nonce every time, so two signals never collide as replays", async () => {
    const { calls, impl } = recordingFetch();
    await deliverWakeNotification(plan, { fetchImpl: impl });
    await deliverWakeNotification(plan, { fetchImpl: impl });

    const nonces = calls.map((c) => (c.init.headers as Record<string, string>)[WAKE_NONCE_HEADER]);
    assert.notEqual(nonces[0], nonces[1]);

    const guard = new WakeGuard({ secret: SECRET });
    for (const call of calls) {
      const headers = call.init.headers as Record<string, string>;
      assert.equal(
        guard.verify({
          timestamp: headers[WAKE_TIMESTAMP_HEADER],
          nonce: headers[WAKE_NONCE_HEADER],
          signature: headers[WAKE_SIGNATURE_HEADER],
        }),
        "authorized"
      );
    }
  });

  it("reports a refused connection instead of throwing", async () => {
    const impl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await deliverWakeNotification(plan, {
      fetchImpl: impl,
      lookupImpl: stubLookup(),
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /ECONNREFUSED/);
  });

  it("reports a non-2xx answer as not-ok, without retrying", async () => {
    const { calls, impl } = recordingFetch(500);
    const result = await deliverWakeNotification(plan, { fetchImpl: impl });
    assert.deepEqual(result, { ok: false, status: 500 });
    assert.equal(calls.length, 1, "one attempt — the fallback tick is the retry");
  });

  it("gives up rather than hanging when the worker never answers", async () => {
    const impl = (async (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;

    const result = await deliverWakeNotification(plan, {
      fetchImpl: impl,
      timeoutMs: 20,
      lookupImpl: stubLookup(),
    });
    assert.equal(result.ok, false);
  });
});

// ─── Seeing WHY a delivery failed ─────────────────────────────────────────────

/**
 * The diagnostic that turns "fetch failed" into an answer.
 *
 * undici reports every connection-level fault — no route, refused, DNS, TLS —
 * with the same three-word message and hides the real one in `cause`. These
 * tests pin the extraction to the shapes Node actually produces, and pin the
 * allow-list that keeps a signed request's headers out of a log.
 */
describe("transport diagnostics on a failed wake", () => {
  const plan = { deliver: true as const, url: configured.WORKER_WAKE_URL!, secret: SECRET };

  /** The exact shape `fetch` throws when a connect() fails. */
  function fetchFailed(cause: unknown): typeof fetch {
    return (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause });
    }) as unknown as typeof fetch;
  }

  /** These tests are about the transport error, so the resolver is stubbed out. */
  function deliver(fetchImpl: typeof fetch) {
    return deliverWakeNotification(plan, { fetchImpl, lookupImpl: stubLookup() });
  }

  it("surfaces the nested cause behind an unreachable network", async () => {
    const cause = Object.assign(new Error("connect ENETUNREACH 2a00:dd80:20::274:10000"), {
      code: "ENETUNREACH",
      syscall: "connect",
      address: "2a00:dd80:20::274",
      port: 10000,
    });

    const result = await deliver(fetchFailed(cause));

    assert.equal(result.ok, false);
    assert.equal(result.error, "fetch failed", "the useless message is still reported");
    assert.equal(result.cause?.code, "ENETUNREACH", "and the useful one now is too");
    assert.equal(result.cause?.syscall, "connect");
    assert.equal(result.cause?.address, "2a00:dd80:20::274");
    assert.equal(result.cause?.port, 10000);
  });

  it("digs through an AggregateError to the first real failure", async () => {
    // What a multi-address connect produces once every address has failed —
    // the outer error carries no code at all.
    const inner = Object.assign(new Error("connect ECONNREFUSED 185.40.234.172:10000"), {
      code: "ECONNREFUSED",
      syscall: "connect",
      address: "185.40.234.172",
      port: 10000,
    });
    const aggregate = Object.assign(new AggregateError([inner], "all attempts failed"), {
      errors: [inner],
    });

    const result = await deliver(fetchFailed(aggregate));

    assert.equal(result.cause?.code, "ECONNREFUSED");
    assert.equal(result.cause?.address, "185.40.234.172");
  });

  it("never lets the request's own credentials travel with the diagnostic", async () => {
    // The realistic hazard: an error shape that carries the request back with
    // it. A generic serialisation of `cause` would put the signature in a log;
    // the allow-list must not.
    const cause = Object.assign(new Error("connect ETIMEDOUT"), {
      code: "ETIMEDOUT",
      syscall: "connect",
      headers: {
        [WAKE_SIGNATURE_HEADER]: "deadbeefsignature",
        [WAKE_NONCE_HEADER]: "nonce-value",
      },
      secret: SECRET,
      request: { headers: { authorization: "Bearer " + SECRET } },
    });

    const result = await deliver(fetchFailed(cause));

    assert.equal(result.cause?.code, "ETIMEDOUT");

    const serialised = JSON.stringify(result);
    assert.equal(serialised.includes(SECRET), false, "the shared secret never appears");
    assert.equal(serialised.includes("deadbeefsignature"), false, "nor the signature");
    assert.equal(serialised.includes("nonce-value"), false, "nor the nonce");
    assert.equal(serialised.includes("Bearer"), false, "nor any authorization header");
    assert.deepEqual(
      Object.keys(result.cause ?? {}).sort(),
      ["code", "message", "name", "syscall"],
      "only allow-listed fields are carried"
    );
  });

  it("leaves an ordinary error without a cause exactly as it was", async () => {
    const impl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const result = await deliver(impl);

    // The `cause` key must be ABSENT, not present-and-undefined: an error that
    // carried nothing useful must not grow an empty field for it.
    assert.equal(Object.hasOwn(result, "cause"), false, "no cause key at all");
    assert.equal(result.ok, false);
    assert.equal(result.error, "ECONNREFUSED");
  });

  it("does not change delivery behaviour — a success is untouched", async () => {
    const { calls, impl } = recordingFetch(202);
    const result = await deliverWakeNotification(plan, { fetchImpl: impl });

    assert.deepEqual(result, { ok: true, status: 202 }, "no cause key on the happy path");
    assert.equal(calls.length, 1, "still exactly one request");
    // The signed headers are still built and sent, unchanged.
    const headers = calls[0].init.headers as Record<string, string>;
    assert.ok(headers[WAKE_SIGNATURE_HEADER], "still signed");
    assert.ok(headers[WAKE_TIMESTAMP_HEADER], "still timestamped");
    assert.ok(headers[WAKE_NONCE_HEADER], "still nonced");
  });

  it("reports nothing rather than noise when the cause is empty or absent", async () => {
    for (const cause of [undefined, null, "a string", 42, {}]) {
      const result = await deliver(fetchFailed(cause));
      assert.equal(result.ok, false);
      assert.equal(result.cause, undefined, `no cause reported for ${String(cause)}`);
    }
  });
});

// ─── Telling the failure classes apart ────────────────────────────────────────

/**
 * Why a wake failed, in enough detail to act on.
 *
 * Production showed the same enqueue fail two different ways on two different
 * days — `fetch failed` once, `The operation was aborted due to timeout` the
 * next — and neither message says whether the connection was refused, blackholed
 * or simply never attempted over a family the host cannot route. These three
 * additions close that gap: the error's NAME separates an abort from a connect
 * failure, ELAPSED time separates "died at the deadline" from "died instantly",
 * and the resolver's ORDER says which address the connection would have reached
 * for first.
 */
describe("failure-class diagnostics", () => {
  const plan = { deliver: true as const, url: configured.WORKER_WAKE_URL!, secret: SECRET };

  /** What `AbortSignal.timeout` actually rejects with — verified against Node. */
  function timeoutAbort(): typeof fetch {
    return (async () => {
      // A DOMException, not an Error subclass with a code: its only own property
      // is `stack`, it has no `cause`, and `name` is the sole distinguishing mark.
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as unknown as typeof fetch;
  }

  it("names a timeout, which no other field can identify", async () => {
    const result = await deliverWakeNotification(plan, {
      fetchImpl: timeoutAbort(),
      lookupImpl: stubLookup(),
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, "The operation was aborted due to timeout");
    assert.equal(result.errorName, "TimeoutError");
    // The point of the field: a DOMException offers nothing else to go on.
    assert.equal(result.cause, undefined, "a timeout carries no cause to extract");
  });

  it("distinguishes an abort from a transport failure by name", async () => {
    const aborted = (async () => {
      throw new DOMException("This operation was aborted", "AbortError");
    }) as unknown as typeof fetch;
    const refused = (async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      });
    }) as unknown as typeof fetch;

    const a = await deliverWakeNotification(plan, {
      fetchImpl: aborted,
      lookupImpl: stubLookup(),
    });
    const b = await deliverWakeNotification(plan, {
      fetchImpl: refused,
      lookupImpl: stubLookup(),
    });

    assert.equal(a.errorName, "AbortError");
    assert.equal(b.errorName, "TypeError");
    assert.equal(b.cause?.code, "ECONNREFUSED", "the cause diagnostic still works alongside");
  });

  it("reports how long the request took before it gave up", async () => {
    // A clock that advances 3002ms across the attempt — the production case.
    const readings = [1_000_000, 1_003_002, 1_003_002];
    let i = 0;
    const now = () => readings[Math.min(i++, readings.length - 1)];

    const result = await deliverWakeNotification(plan, {
      fetchImpl: timeoutAbort(),
      lookupImpl: stubLookup(),
      now,
    });

    assert.equal(result.elapsedMs, 3002, "the gap between the deadline and an instant failure");
  });

  it("measures the request alone, not the DNS probe that follows it", async () => {
    // Elapsed is read BEFORE the probe runs, so a slow resolver cannot inflate
    // the number that says how long the worker was given to answer.
    const readings = [0, 50, 50, 900];
    let i = 0;
    const now = () => readings[Math.min(i++, readings.length - 1)];

    const result = await deliverWakeNotification(plan, {
      fetchImpl: timeoutAbort(),
      lookupImpl: stubLookup([{ address: "185.40.234.37", family: 4 }]),
      probeImpl: stubProbe(),
      now,
    });

    assert.equal(result.elapsedMs, 50, "the request took 50ms");
    assert.equal(result.dns?.elapsedMs, 850, "the probe's own cost is reported separately");
  });

  it("preserves resolver order, because order is the entire question", async () => {
    // The shape that would explain production: IPv6 first on a host that also
    // has IPv4, reached from somewhere with no IPv6 route.
    const result = await deliverWakeNotification(plan, {
      fetchImpl: timeoutAbort(),
      lookupImpl: stubLookup([
        { address: "2a00:dd80:20::274", family: 6 },
        { address: "2a00:dd80:20::ae9", family: 6 },
        { address: "185.40.234.37", family: 4 },
      ]),
      probeImpl: stubProbe(),
    });

    assert.deepEqual(result.dns?.addresses, [
      { address: "2a00:dd80:20::274", family: 6 },
      { address: "2a00:dd80:20::ae9", family: 6 },
      { address: "185.40.234.37", family: 4 },
    ]);
    assert.equal(result.dns?.addresses?.[0].family, 6, "what the connection would have tried");
  });

  it("does not resolve anything when the wake succeeds", async () => {
    let lookups = 0;
    const { impl } = recordingFetch(202);
    const result = await deliverWakeNotification(plan, {
      fetchImpl: impl,
      lookupImpl: async () => {
        lookups += 1;
        return [];
      },
    });

    assert.equal(lookups, 0, "the happy path pays nothing for the diagnostic");
    // And the success shape is byte-for-byte what it was before any of this.
    assert.deepEqual(result, { ok: true, status: 202 });
  });

  it("does not resolve anything for a non-2xx answer either", async () => {
    // A 500 means DNS, connect and TLS all worked — there is nothing to ask.
    let lookups = 0;
    const { impl } = recordingFetch(500);
    const result = await deliverWakeNotification(plan, {
      fetchImpl: impl,
      lookupImpl: async () => {
        lookups += 1;
        return [];
      },
    });

    assert.equal(lookups, 0);
    assert.deepEqual(result, { ok: false, status: 500 });
  });

  it("keeps the original failure when the resolver fails too", async () => {
    const result = await deliverWakeNotification(plan, {
      fetchImpl: timeoutAbort(),
      lookupImpl: async () => {
        throw Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" });
      },
    });

    // The wake failure is what the reader came for; the probe is a footnote.
    assert.equal(result.ok, false);
    assert.equal(result.error, "The operation was aborted due to timeout");
    assert.equal(result.errorName, "TimeoutError");
    assert.match(result.dns?.error ?? "", /EAI_AGAIN/);
    assert.equal(result.dns?.addresses, undefined);
  });

  it("does not hang forever on a resolver that never answers", async () => {
    const result = await deliverWakeNotification(plan, {
      fetchImpl: timeoutAbort(),
      lookupImpl: () => new Promise(() => {}),
      dnsTimeoutMs: 20,
    });

    assert.equal(result.ok, false, "the wake failure still comes back");
    assert.match(result.dns?.error ?? "", /timed out after 20ms/);
  });

  it("carries nothing from the resolver but an address and a family", async () => {
    const result = await deliverWakeNotification(plan, {
      fetchImpl: timeoutAbort(),
      lookupImpl: async () =>
        [
          {
            address: "185.40.234.37",
            family: 4,
            // A hostile/careless resolver shape. None of this may survive.
            secret: SECRET,
            [WAKE_SIGNATURE_HEADER]: "deadbeefsignature",
            headers: { authorization: "Bearer " + SECRET },
          },
        ] as unknown as Array<{ address: string; family: number }>,
      probeImpl: stubProbe(),
    });

    assert.deepEqual(result.dns?.addresses, [{ address: "185.40.234.37", family: 4 }]);

    const serialised = JSON.stringify(result);
    assert.equal(serialised.includes(SECRET), false, "the shared secret never appears");
    assert.equal(serialised.includes("deadbeefsignature"), false, "nor the signature");
    assert.equal(serialised.includes("Bearer"), false, "nor any authorization header");
  });

  it("drops malformed resolver entries rather than reporting junk", async () => {
    const result = await deliverWakeNotification(plan, {
      fetchImpl: timeoutAbort(),
      lookupImpl: async () =>
        [
          null,
          "185.40.234.37",
          { address: "1.2.3.4" },
          { family: 4 },
          { address: "5.6.7.8", family: 6 },
        ] as unknown as Array<{
          address: string;
          family: number;
        }>,
      probeImpl: stubProbe(),
    });

    assert.deepEqual(result.dns?.addresses, [{ address: "5.6.7.8", family: 6 }]);
  });
});

// ─── Which family is actually reachable ───────────────────────────────────────

/**
 * The question `fetch` refuses to answer.
 *
 * A wake that times out could mean the worker is down, the Funnel is down, or
 * one address family is being dropped on the floor — and `fetch` picks the
 * address itself and then reports the same three words either way. These probes
 * dial one address of each family directly, after the fact, so the three cases
 * stop being the same observation.
 */
describe("per-family connectivity probes", () => {
  const plan = { deliver: true as const, url: configured.WORKER_WAKE_URL!, secret: SECRET };
  const dualStack = stubLookup([
    { address: "2a00:dd80:20::274", family: 6 },
    { address: "2a00:dd80:20::ae9", family: 6 },
    { address: "185.40.234.37", family: 4 },
    { address: "185.40.234.172", family: 4 },
  ]);

  function timeoutAbort(): typeof fetch {
    return (async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as unknown as typeof fetch;
  }

  it("probes exactly one address per family, never all of them", async () => {
    const dialled: Array<{ address: string; family: number }> = [];
    const result = await deliverWakeNotification(plan, {
      fetchImpl: timeoutAbort(),
      lookupImpl: dualStack,
      probeImpl: async (target) => {
        dialled.push({ address: target.address, family: target.family });
        return { address: target.address, family: target.family, connected: false, elapsedMs: 1 };
      },
    });

    assert.deepEqual(dialled.map((d) => d.family).sort(), [4, 6], "one of each, and only one");
    assert.equal(result.probes?.ipv4?.address, "185.40.234.37", "the FIRST v4, as resolved");
    assert.equal(result.probes?.ipv6?.address, "2a00:dd80:20::274", "the first v6");
  });

  it("carries the wake URL's port and SNI into the probe", async () => {
    // Otherwise the probe would test an unrelated socket condition rather than
    // the Funnel path the wake actually uses — the Funnel routes on SNI.
    const targets: Array<{ port: number; servername?: string }> = [];
    await deliverWakeNotification(plan, {
      fetchImpl: timeoutAbort(),
      lookupImpl: dualStack,
      probeImpl: async (target) => {
        targets.push({ port: target.port, servername: target.servername });
        return { address: target.address, family: target.family, connected: false, elapsedMs: 1 };
      },
    });

    for (const target of targets) {
      assert.equal(target.port, 10000, "the configured wake port, not 443");
      assert.equal(target.servername, "worker.example.ts.net", "SNI for the Funnel");
    }
  });

  it("reports the families independently — the signature we are looking for", async () => {
    // IPv4 reachable, IPv6 silently dropped: exactly what would explain a wake
    // that hangs to its deadline against a host that answers fine over IPv4.
    const result = await deliverWakeNotification(plan, {
      fetchImpl: timeoutAbort(),
      lookupImpl: dualStack,
      probeImpl: async (target) =>
        target.family === 4
          ? {
              address: target.address,
              family: 4,
              connected: true,
              elapsedMs: 412,
              tcpMs: 128,
              reached: "tls" as const,
            }
          : {
              address: target.address,
              family: 6,
              connected: false,
              elapsedMs: 2000,
              errorName: "TimeoutError",
              errorMessage: "no TCP handshake within 2000ms",
            },
    });

    assert.equal(result.probes?.ipv4?.connected, true);
    assert.equal(result.probes?.ipv4?.reached, "tls");
    assert.equal(result.probes?.ipv6?.connected, false);
    assert.equal(result.probes?.ipv6?.tcpMs, undefined, "never got a TCP handshake");
  });

  it("distinguishes an unroutable address from a TLS failure", async () => {
    // `tcpMs` present is the whole tell: the packets landed, so whatever failed
    // afterwards is not a routing problem.
    const result = await deliverWakeNotification(plan, {
      fetchImpl: timeoutAbort(),
      lookupImpl: stubLookup([{ address: "185.40.234.37", family: 4 }]),
      probeImpl: async (target) => ({
        address: target.address,
        family: target.family,
        connected: false,
        elapsedMs: 300,
        tcpMs: 120,
        reached: "tcp" as const,
        errorCode: "ERR_TLS_CERT_ALTNAME_INVALID",
        errorMessage: "tls: hostname mismatch",
      }),
    });

    const line = formatWakeFailure(result);
    assert.match(String(line.ipv4Probe), /reachable \(TCP in 120ms\) but TLS failed/);
    assert.doesNotMatch(String(line.ipv4Probe), /NO TCP/);
  });

  it("does not probe when the wake succeeds", async () => {
    let probes = 0;
    const { impl } = recordingFetch(202);
    await deliverWakeNotification(plan, {
      fetchImpl: impl,
      lookupImpl: dualStack,
      probeImpl: async (target) => {
        probes += 1;
        return { address: target.address, family: target.family, connected: false, elapsedMs: 1 };
      },
    });
    assert.equal(probes, 0);
  });

  it("does not probe when the resolver returned nothing to probe", async () => {
    let probes = 0;
    const result = await deliverWakeNotification(plan, {
      fetchImpl: timeoutAbort(),
      lookupImpl: stubLookup([]),
      probeImpl: async (target) => {
        probes += 1;
        return { address: target.address, family: target.family, connected: false, elapsedMs: 1 };
      },
    });
    assert.equal(probes, 0);
    assert.equal(result.probes, undefined);
  });

  it("survives a probe that hangs, and still reports the wake failure", async () => {
    const result = await deliverWakeNotification(plan, {
      fetchImpl: timeoutAbort(),
      lookupImpl: dualStack,
      probeImpl: () => new Promise(() => {}),
      probeTimeoutMs: 20,
    });

    assert.equal(result.ok, false, "the wake failure is still what comes back");
    assert.equal(result.error, "The operation was aborted due to timeout");
    assert.equal(result.probes?.ipv4?.connected, false);
    assert.equal(result.probes?.ipv4?.errorName, "ProbeError");
  });

  it("survives a probe that throws", async () => {
    const result = await deliverWakeNotification(plan, {
      fetchImpl: timeoutAbort(),
      lookupImpl: dualStack,
      probeImpl: async () => {
        throw new Error("socket module exploded");
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.errorName, "TimeoutError", "the original failure is intact");
    assert.equal(result.probes?.ipv6?.errorName, "ProbeError");
  });

  it("tears down a TLS upgrade without taking the process with it", async () => {
    // A REAL socket test, deliberately: destroying a TLSSocket *and* the raw
    // socket it wraps segfaults Node (0xC0000005, reproduced 3/3), and only the
    // real probe can catch that — a stub proves nothing about handle teardown.
    // A plain TCP server is enough: the upgrade is attempted, so the TLSSocket
    // exists, and the handshake then fails. No certificate needed.
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const result = await deliverWakeNotification(
        { deliver: true, url: `https://127.0.0.1:${port}/wake`, secret: SECRET },
        {
          fetchImpl: (async () => {
            throw new TypeError("fetch failed");
          }) as unknown as typeof fetch,
          // Real resolver and real probe — that is the point of this test.
          probeTimeoutMs: 500,
        }
      );

      assert.equal(result.probes?.ipv4?.connected, false, "the TLS handshake could not complete");
      assert.equal(
        typeof result.probes?.ipv4?.tcpMs,
        "number",
        "but TCP did — proving the split between routing and handshake faults"
      );
      assert.equal(result.probes?.ipv4?.reached, "tcp");
    } finally {
      server.close();
    }
  });

  it("runs the two probes in parallel, not one after the other", async () => {
    // Sequential probes would double the delay added to an invocation that has
    // already blown its budget.
    let live = 0;
    let peak = 0;
    await deliverWakeNotification(plan, {
      fetchImpl: timeoutAbort(),
      lookupImpl: dualStack,
      probeImpl: async (target) => {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 10));
        live -= 1;
        return { address: target.address, family: target.family, connected: false, elapsedMs: 10 };
      },
    });

    assert.equal(peak, 2, "both were in flight at once");
  });
});

// ─── Making it readable in a log ──────────────────────────────────────────────

/**
 * A diagnostic nobody can read is not a diagnostic.
 *
 * Production captured all six resolved addresses and printed
 * `[ [Object], [Object], [Object], [Object], [Object], [Object] ]`, because
 * `console.warn` inspects to depth 2 and the address objects sit at depth 3.
 * These tests pin the flattening that fixes it.
 */
describe("formatWakeFailure", () => {
  it("renders every address as a readable string, in resolver order", () => {
    const line = formatWakeFailure({
      ok: false,
      error: "The operation was aborted due to timeout",
      dns: {
        elapsedMs: 54,
        addresses: [
          { address: "2a00:dd80:20::274", family: 6 },
          { address: "185.40.234.37", family: 4 },
        ],
      },
    });

    assert.deepEqual(line.dnsAddresses, ["IPv6 2a00:dd80:20::274", "IPv4 185.40.234.37"]);
    assert.equal(line.dnsElapsedMs, 54);
  });

  it("nests nothing deep enough for console.warn to hide it", () => {
    const line = formatWakeFailure({
      ok: false,
      error: "boom",
      dns: {
        elapsedMs: 1,
        addresses: [
          { address: "2a00:dd80:20::274", family: 6 },
          { address: "185.40.234.37", family: 4 },
        ],
      },
      probes: {
        ipv4: { address: "185.40.234.37", family: 4, connected: true, elapsedMs: 9, tcpMs: 3 },
      },
    });

    // The real check: reproduce console.warn's own depth-2 formatting and assert
    // the word that meant "this diagnostic was lost" never appears.
    const rendered = inspect(line, { depth: 2 });
    assert.doesNotMatch(rendered, /\[Object\]/);
    assert.doesNotMatch(rendered, /\[Array\]/);
    assert.match(rendered, /IPv6 2a00:dd80:20::274/);
    assert.match(rendered, /185\.40\.234\.37/);
  });

  it("says plainly when an address never completed a TCP handshake", () => {
    const line = formatWakeFailure({
      ok: false,
      error: "boom",
      probes: {
        ipv6: {
          address: "2a00:dd80:20::274",
          family: 6,
          connected: false,
          elapsedMs: 2000,
          errorName: "TimeoutError",
          errorMessage: "no TCP handshake within 2000ms",
        },
      },
    });

    assert.match(String(line.ipv6Probe), /IPv6 2a00:dd80:20::274 FAILED after 2000ms/);
    assert.match(String(line.ipv6Probe), /NO TCP — unreachable, filtered, or silently dropped/);
  });

  it("does not call a refused connection unreachable — it is the opposite", () => {
    // ECONNREFUSED also has no TCP handshake, but it PROVES the address routes.
    // Reading it as "unreachable" would point the investigation backwards.
    const line = formatWakeFailure({
      ok: false,
      error: "boom",
      probes: {
        ipv4: {
          address: "185.40.234.37",
          family: 4,
          connected: false,
          elapsedMs: 2,
          errorCode: "ECONNREFUSED",
          errorMessage: "tcp: connect ECONNREFUSED",
        },
      },
    });

    assert.match(String(line.ipv4Probe), /routable, but the port refused the connection/);
    assert.doesNotMatch(String(line.ipv4Probe), /unreachable/);
  });

  it("carries the timing fields that explain an overshooting deadline", () => {
    const line = formatWakeFailure({
      ok: false,
      error: "The operation was aborted due to timeout",
      errorName: "TimeoutError",
      elapsedMs: 5716,
      timeoutMs: 3000,
      abortAfterMs: 3001,
      cpuMs: 12,
    });

    assert.equal(line.elapsedMs, 5716);
    assert.equal(line.timeoutMs, 3000);
    assert.equal(line.abortAfterMs, 3001);
    assert.equal(line.cpuMs, 12);
  });

  it("omits every field it has nothing to say about", () => {
    const line = formatWakeFailure({ ok: false, status: 500 });
    assert.deepEqual(Object.keys(line), ["status", "error"]);
  });

  it("leaks nothing, whatever the result carries", () => {
    const line = formatWakeFailure({
      ok: false,
      error: "fetch failed",
      cause: { code: "ENETUNREACH", message: "connect ENETUNREACH", address: "2a00:dd80:20::274" },
      dns: { elapsedMs: 1, addresses: [{ address: "185.40.234.37", family: 4 }] },
      probes: {
        ipv4: {
          address: "185.40.234.37",
          family: 4,
          connected: false,
          elapsedMs: 1,
          errorMessage: "tcp: connect ECONNREFUSED",
        },
      },
    });

    const serialised = JSON.stringify(line);
    assert.equal(serialised.includes(SECRET), false);
    assert.equal(serialised.toLowerCase().includes("authorization"), false);
    assert.equal(serialised.includes(WAKE_SIGNATURE_HEADER), false);
    assert.equal(serialised.includes(WAKE_NONCE_HEADER), false);
  });
});

// ─── Why a 3-second budget took 5.7 seconds ───────────────────────────────────

/**
 * Production reported `elapsedMs: 5716` against a 3000ms `AbortSignal.timeout`.
 *
 * Three things could produce that, and they have different fixes: the timer
 * fired on time and the rejection arrived late (undici teardown); the timer
 * itself fired late because the event loop was saturated; or the timer fired
 * late because the process was not running at all. `abortAfterMs` splits the
 * first from the other two, and `cpuMs` splits those two from each other.
 */
describe("overshooting the abort deadline", () => {
  const plan = { deliver: true as const, url: configured.WORKER_WAKE_URL!, secret: SECRET };

  it("records when the signal fired, separately from when the request settled", async () => {
    // A fetch that observes the real abort and then takes its time rejecting —
    // the "punctual timer, late rejection" case.
    const impl = (async (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          setTimeout(() => reject(new DOMException("aborted", "TimeoutError")), 40);
        });
      })) as unknown as typeof fetch;

    const result = await deliverWakeNotification(plan, {
      fetchImpl: impl,
      timeoutMs: 30,
      lookupImpl: stubLookup(),
    });

    assert.equal(result.ok, false);
    assert.equal(typeof result.abortAfterMs, "number");
    assert.ok(
      result.abortAfterMs! < result.elapsedMs!,
      `the signal fired at ${result.abortAfterMs}ms, the request settled at ${result.elapsedMs}ms`
    );
    assert.equal(result.timeoutMs, 30, "the budget is reported next to the measurement");
  });

  it("leaves abortAfterMs absent when the failure was not an abort at all", async () => {
    const impl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const result = await deliverWakeNotification(plan, {
      fetchImpl: impl,
      lookupImpl: stubLookup(),
    });

    assert.equal(result.abortAfterMs, undefined, "nothing aborted, so nothing to report");
    assert.equal(result.timeoutMs, 3000, "the default budget is still reported");
  });

  it("reports CPU time, which separates a busy loop from a frozen process", async () => {
    const impl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const result = await deliverWakeNotification(plan, {
      fetchImpl: impl,
      lookupImpl: stubLookup(),
    });

    assert.equal(typeof result.cpuMs, "number");
    assert.ok(result.cpuMs! >= 0);
  });

  it("still aborts the real request on the configured budget", async () => {
    // The listener is passive: the signal must still do its job.
    let sawAbort = false;
    const impl = (async (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          sawAbort = true;
          reject(new DOMException("aborted", "TimeoutError"));
        });
      })) as unknown as typeof fetch;

    const result = await deliverWakeNotification(plan, {
      fetchImpl: impl,
      timeoutMs: 20,
      lookupImpl: stubLookup(),
    });

    assert.equal(sawAbort, true, "the request still receives the abort");
    assert.equal(result.ok, false);
  });
});

describe("describeWakeDns", () => {
  it("never throws, whatever the resolver does", async () => {
    for (const lookupImpl of [
      (() => {
        throw new Error("sync boom");
      }) as unknown as WakeDnsLookup,
      (async () => {
        throw new Error("async boom");
      }) as WakeDnsLookup,
      (async () => null) as unknown as WakeDnsLookup,
      (async () => "not an array") as unknown as WakeDnsLookup,
    ]) {
      const dns = await describeWakeDns("worker.example.ts.net", { lookupImpl });
      assert.equal(typeof dns.elapsedMs, "number");
    }
  });
});

// ─── Scheduling: never the caller's problem ───────────────────────────────────

describe("scheduleWakeNotification", () => {
  it("returns before the request happens", () => {
    let started = false;
    scheduleWakeNotification({
      env: configured,
      scheduler: () => {
        started = true;
      },
      fetchImpl: recordingFetch().impl,
    });
    // The scheduler ran (synchronously, here), but nothing was awaited.
    assert.equal(started, true);
  });

  it("schedules nothing at all from the worker process", () => {
    let scheduled = 0;
    scheduleWakeNotification({
      env: { ...configured, WORKER_PROCESS: "1" },
      scheduler: () => {
        scheduled += 1;
      },
    });
    assert.equal(scheduled, 0);
  });

  it("swallows a scheduler that throws", () => {
    assert.doesNotThrow(() =>
      scheduleWakeNotification({
        env: configured,
        scheduler: () => {
          throw new Error("after() outside a request scope");
        },
      })
    );
  });

  it("swallows a delivery failure", async () => {
    const { settle, scheduler } = immediateScheduler();
    const results: unknown[] = [];
    assert.doesNotThrow(() =>
      scheduleWakeNotification({
        env: configured,
        scheduler,
        fetchImpl: (async () => {
          throw new Error("tunnel down");
        }) as unknown as typeof fetch,
        lookupImpl: stubLookup(),
        onResult: (r) => void results.push(r),
      })
    );
    await settle();
    assert.equal((results[0] as { ok: boolean }).ok, false);
  });

  it("uses the installed scheduler, and restores the default when cleared", async () => {
    const installed: Array<() => Promise<void>> = [];
    setWakeScheduler((task) => void installed.push(task));
    try {
      scheduleWakeNotification({ env: configured, fetchImpl: recordingFetch().impl });
      assert.equal(installed.length, 1, "the host's scheduler was used");
    } finally {
      setWakeScheduler(null);
    }

    // With the default restored, delivery is detached — it must still not throw.
    assert.doesNotThrow(() =>
      scheduleWakeNotification({
        env: configured,
        fetchImpl: recordingFetch().impl,
      })
    );
  });
});

// ─── The scheduler must survive a duplicated module ───────────────────────────

/**
 * The production defect this section exists for.
 *
 * Everything above loads `./wake-notifier` exactly once, which is the one shape
 * the bug could not appear in — and so it shipped. In the Turbopack build this
 * file is MERGED into the chunk `enqueue-job.service.ts` occupies AND emitted
 * again, standalone, in the chunk `instrumentation.ts` imports. `register()`
 * installed the `after()` wrapper on the second copy; every enqueue read the
 * first, still holding the detached default. The wake fetch therefore ran with
 * nothing keeping the serverless invocation alive, and Vercel suspended the
 * sandbox mid-handshake: an abort budgeted at 3000ms firing at 5703ms, 62ms of
 * CPU across 5.7s, while TCP to the ingress had completed in 96ms.
 *
 * A `?copy=` query gives the ESM loader a second module key for the same file,
 * which is the closest a single process gets to what the bundler emits: two live
 * instances, each with its own module scope, sharing one `globalThis`.
 */
async function loadSecondInstance(): Promise<typeof import("./wake-notifier")> {
  return import(`./wake-notifier.ts?copy=${Math.random()}`) as Promise<
    typeof import("./wake-notifier")
  >;
}

describe("scheduler installation across module instances", () => {
  it("a scheduler installed on one instance is used by another", async () => {
    const other = await loadSecondInstance();
    assert.notEqual(other.scheduleWakeNotification, scheduleWakeNotification);

    const installed: Array<() => Promise<void>> = [];
    // Installed HERE — standing in for `instrumentation.ts`'s copy.
    setWakeScheduler((task) => void installed.push(task));
    try {
      // Scheduled THERE — standing in for the copy merged into the enqueue path.
      other.scheduleWakeNotification({ env: configured, fetchImpl: recordingFetch().impl });
      assert.equal(
        installed.length,
        1,
        "the other instance fell back to the detached scheduler — `after()` would never run and Vercel would freeze the request"
      );
    } finally {
      setWakeScheduler(null);
    }
  });

  it("clearing on one instance restores the detached default on the other", async () => {
    const other = await loadSecondInstance();

    const installed: Array<() => Promise<void>> = [];
    setWakeScheduler((task) => void installed.push(task));
    setWakeScheduler(null);

    // Detached means the task runs itself rather than being handed anywhere, so
    // the delivery still happens — it is only nobody's job to wait for it.
    const { calls, impl } = recordingFetch();
    other.scheduleWakeNotification({ env: configured, fetchImpl: impl });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(installed.length, 0, "a cleared scheduler must not still be collecting tasks");
    assert.equal(calls.length, 1, "the detached default must still deliver");
  });

  it("the worker's copy still refuses to signal itself, whatever is installed", async () => {
    const other = await loadSecondInstance();

    const installed: Array<() => Promise<void>> = [];
    setWakeScheduler((task) => void installed.push(task));
    try {
      other.scheduleWakeNotification({
        env: { ...configured, WORKER_PROCESS: "1" },
        fetchImpl: recordingFetch().impl,
      });
      // A shared slot must not become a way for the worker to reach a scheduler
      // it was always meant to skip: the plan refuses before scheduling at all.
      assert.equal(installed.length, 0);
    } finally {
      setWakeScheduler(null);
    }
  });
});
