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

import {
  planWakeNotification,
  deliverWakeNotification,
  scheduleWakeNotification,
  setWakeScheduler,
  type WakeNotifierEnv,
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
    const result = await deliverWakeNotification(plan, { fetchImpl: impl });
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

    const result = await deliverWakeNotification(plan, { fetchImpl: impl, timeoutMs: 20 });
    assert.equal(result.ok, false);
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
