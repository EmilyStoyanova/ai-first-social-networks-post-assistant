/**
 * The wake endpoint, over a real socket.
 *
 * Two things are being checked, and they pull in opposite directions:
 *
 *   • that a legitimately signed request reaches the latch, and
 *   • that NOTHING else does — not an unsigned request, not a captured one
 *     replayed, not one whose clock has drifted past the window, not a GET, not
 *     a different path, and not a caller trying to smuggle instructions in a
 *     body the endpoint pretends not to have.
 *
 * The last of those is the one worth being explicit about. The endpoint's safety
 * argument rests on it having no vocabulary at all: a forged wake can only make
 * the worker look at a queue it was going to look at anyway. Tests here pin that
 * down by proving a request carrying a job id, a command, or a payload is
 * treated exactly like an empty one.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { createLogger } from "./logger";
import { createWakeServer, type WakeServer } from "./wake-server";
import { WakeSignal } from "./wake-signal";
import {
  WAKE_NONCE_HEADER,
  WAKE_SIGNATURE_HEADER,
  WAKE_TIMESTAMP_HEADER,
  WakeGuard,
  createWakeCredentials,
  signWakePayload,
} from "@/lib/security/wake-auth";

const SECRET = "test-secret-value-long-enough-to-be-real";
const silentLogger = createLogger("test", () => {});

// ─── Guard, in isolation ──────────────────────────────────────────────────────

describe("WakeGuard", () => {
  const at = (now: number) => new WakeGuard({ secret: SECRET, now: () => now });

  it("authorizes a freshly signed request", () => {
    const guard = at(1_000_000);
    const creds = createWakeCredentials(SECRET, 1_000_000);
    assert.equal(guard.verify(creds), "authorized");
  });

  it("refuses a request signed with the wrong secret", () => {
    const guard = at(1_000_000);
    const creds = createWakeCredentials("not-the-secret", 1_000_000);
    assert.equal(guard.verify(creds), "bad_signature");
  });

  it("refuses a signature that is merely close", () => {
    const guard = at(1_000_000);
    const creds = createWakeCredentials(SECRET, 1_000_000);
    const tampered = `${creds.signature.slice(0, -1)}${creds.signature.endsWith("a") ? "b" : "a"}`;
    assert.equal(guard.verify({ ...creds, signature: tampered }), "bad_signature");
  });

  it("refuses a signature of the right shape but the wrong length", () => {
    // timingSafeEqual throws on a length mismatch; the guard must answer, not blow up.
    const guard = at(1_000_000);
    const creds = createWakeCredentials(SECRET, 1_000_000);
    assert.equal(
      guard.verify({ ...creds, signature: creds.signature.slice(0, 32) }),
      "bad_signature"
    );
  });

  it("refuses a request whose timestamp has drifted out of the window", () => {
    const guard = at(1_000_000);
    const creds = createWakeCredentials(SECRET, 1_000_000 - 61_000);
    assert.equal(guard.verify(creds), "expired");
  });

  it("refuses a timestamp from the future too, not only a stale one", () => {
    const guard = at(1_000_000);
    const creds = createWakeCredentials(SECRET, 1_000_000 + 61_000);
    assert.equal(guard.verify(creds), "expired");
  });

  it("accepts a request at the very edge of the window", () => {
    const guard = at(1_000_000);
    const creds = createWakeCredentials(SECRET, 1_000_000 - 60_000);
    assert.equal(guard.verify(creds), "authorized");
  });

  it("refuses a captured request replayed inside its window", () => {
    const guard = at(1_000_000);
    const creds = createWakeCredentials(SECRET, 1_000_000);
    assert.equal(guard.verify(creds), "authorized");
    assert.equal(guard.verify(creds), "replayed", "the same nonce does not work twice");
  });

  it("binds the signature to the timestamp, so a captured one cannot be re-dated", () => {
    // Without the timestamp inside the signed string, an attacker could keep a
    // captured signature alive indefinitely by advancing the header.
    const guard = at(1_000_000);
    const creds = createWakeCredentials(SECRET, 1_000_000 - 120_000);
    assert.equal(guard.verify({ ...creds, timestamp: 1_000_000 }), "bad_signature");
  });

  it("binds the signature to the nonce, so a fresh nonce cannot dodge the replay check", () => {
    const guard = at(1_000_000);
    const creds = createWakeCredentials(SECRET, 1_000_000);
    assert.equal(guard.verify(creds), "authorized");
    assert.equal(guard.verify({ ...creds, nonce: "a-different-nonce" }), "bad_signature");
  });

  it("treats missing headers as malformed rather than as an error", () => {
    const guard = at(1_000_000);
    const creds = createWakeCredentials(SECRET, 1_000_000);
    assert.equal(guard.verify({ ...creds, signature: null }), "malformed");
    assert.equal(guard.verify({ ...creds, nonce: undefined }), "malformed");
    assert.equal(guard.verify({ ...creds, timestamp: null }), "malformed");
  });

  it("refuses a non-numeric timestamp", () => {
    const guard = at(1_000_000);
    const creds = createWakeCredentials(SECRET, 1_000_000);
    assert.equal(guard.verify({ ...creds, timestamp: "not-a-number" }), "malformed");
  });

  it("refuses an absurdly sized nonce before it can be remembered", () => {
    const guard = at(1_000_000);
    const nonce = "x".repeat(5_000);
    assert.equal(
      guard.verify({
        timestamp: "1000000",
        nonce,
        signature: signWakePayload(SECRET, 1_000_000, nonce),
      }),
      "malformed"
    );
  });

  it("rate-limits before it does any cryptography", () => {
    const guard = new WakeGuard({
      secret: SECRET,
      rateMaxPerWindow: 3,
      now: () => 1_000_000,
    });
    for (let i = 0; i < 3; i += 1) {
      assert.equal(guard.verify(createWakeCredentials(SECRET, 1_000_000)), "authorized");
    }
    assert.equal(guard.verify(createWakeCredentials(SECRET, 1_000_000)), "rate_limited");
  });

  it("opens a fresh budget in the next window", () => {
    let now = 1_000_000;
    const guard = new WakeGuard({ secret: SECRET, rateMaxPerWindow: 1, now: () => now });
    assert.equal(guard.verify(createWakeCredentials(SECRET, now)), "authorized");
    assert.equal(guard.verify(createWakeCredentials(SECRET, now)), "rate_limited");

    now += 60_001;
    assert.equal(guard.verify(createWakeCredentials(SECRET, now)), "authorized");
  });

  it("never lets unauthenticated traffic grow the replay cache", () => {
    // The replay check runs after the signature check for exactly this reason:
    // otherwise anyone could fill the nonce map from the open internet.
    const guard = new WakeGuard({ secret: SECRET, rateMaxPerWindow: 10_000, now: () => 1_000_000 });
    for (let i = 0; i < 500; i += 1) {
      guard.verify({ timestamp: "1000000", nonce: `nonce-${i}`, signature: "0".repeat(64) });
    }
    assert.equal(guard.trackedNonceCount(), 0);
  });

  it("forgets a nonce once it can no longer pass the clock check", () => {
    let now = 1_000_000;
    const guard = new WakeGuard({ secret: SECRET, now: () => now });
    guard.verify(createWakeCredentials(SECRET, now));
    assert.equal(guard.trackedNonceCount(), 1);

    now += 200_000; // past the nonce TTL
    guard.verify(createWakeCredentials(SECRET, now));
    assert.equal(guard.trackedNonceCount(), 1, "the expired nonce was pruned, not accumulated");
  });

  it("reports itself unconfigured when no secret is set, and authorizes nothing", () => {
    const guard = new WakeGuard({ secret: undefined });
    assert.equal(guard.isConfigured(), false);
    assert.equal(guard.verify(createWakeCredentials(SECRET)), "not_configured");
  });

  it("treats an empty-string secret as no secret", () => {
    assert.equal(new WakeGuard({ secret: "" }).isConfigured(), false);
  });
});

// ─── Over the wire ────────────────────────────────────────────────────────────

describe("wake server", () => {
  let server: WakeServer;
  let signal: WakeSignal;
  let wakes: number;
  let port: number;
  /** Fixed so signing and verifying agree without depending on wall-clock drift. */
  const clock = 2_000_000;

  before(async () => {
    signal = new WakeSignal();
    wakes = 0;
    signal.subscribe(() => {});
    server = createWakeServer({
      guard: new WakeGuard({ secret: SECRET, rateMaxPerWindow: 10_000, now: () => clock }),
      logger: silentLogger,
      host: "127.0.0.1",
      // Port 0 — the OS picks a free one, so the suite never collides with a
      // real worker or with itself.
      port: 0,
      onWake: () => {
        wakes += 1;
        signal.notify();
      },
    });
    await server.listen();
    port = server.address() ?? 0;
  });

  after(async () => {
    await server.close();
  });

  const url = (path = "/wake") => `http://127.0.0.1:${port}${path}`;

  function signedHeaders(overrides: Record<string, string> = {}): Record<string, string> {
    const creds = createWakeCredentials(SECRET, clock);
    return {
      [WAKE_TIMESTAMP_HEADER]: String(creds.timestamp),
      [WAKE_NONCE_HEADER]: creds.nonce,
      [WAKE_SIGNATURE_HEADER]: creds.signature,
      ...overrides,
    };
  }

  it("accepts a signed POST and fires the latch", async () => {
    const before = wakes;
    const res = await fetch(url(), { method: "POST", headers: signedHeaders() });
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { status: "accepted" });
    assert.equal(wakes, before + 1);
  });

  it("refuses an unsigned POST", async () => {
    const before = wakes;
    const res = await fetch(url(), { method: "POST" });
    assert.equal(res.status, 401);
    assert.equal(wakes, before, "the latch was not touched");
  });

  it("refuses a replayed request", async () => {
    const headers = signedHeaders();
    assert.equal((await fetch(url(), { method: "POST", headers })).status, 202);

    const before = wakes;
    const res = await fetch(url(), { method: "POST", headers });
    assert.equal(res.status, 401);
    assert.equal(wakes, before);
  });

  it("refuses an expired request", async () => {
    const stale = createWakeCredentials(SECRET, clock - 300_000);
    const res = await fetch(url(), {
      method: "POST",
      headers: {
        [WAKE_TIMESTAMP_HEADER]: String(stale.timestamp),
        [WAKE_NONCE_HEADER]: stale.nonce,
        [WAKE_SIGNATURE_HEADER]: stale.signature,
      },
    });
    assert.equal(res.status, 401);
  });

  it("gives every rejection the same body, so it never says which guard tripped", async () => {
    const unsigned = await fetch(url(), { method: "POST" });
    const badSig = await fetch(url(), {
      method: "POST",
      headers: signedHeaders({ [WAKE_SIGNATURE_HEADER]: "0".repeat(64) }),
    });
    assert.equal(unsigned.status, badSig.status);
    assert.deepEqual(await unsigned.json(), await badSig.json());
  });

  it("refuses every method but POST", async () => {
    const before = wakes;
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const res = await fetch(url(), { method, headers: signedHeaders() });
      assert.equal(res.status, 405, `${method} was not refused`);
    }
    assert.equal(wakes, before);
  });

  it("serves no path but /wake", async () => {
    for (const path of ["/", "/jobs", "/wake/now", "/admin"]) {
      const res = await fetch(url(path), { method: "POST", headers: signedHeaders() });
      assert.equal(res.status, 404, `${path} was served`);
    }
  });

  it("ignores a body trying to name a job", async () => {
    // The endpoint has no vocabulary: a signed request means "look at the
    // queue" and nothing a caller writes can change that.
    const before = wakes;
    const res = await fetch(url(), {
      method: "POST",
      headers: { ...signedHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ jobId: "j-victim", command: "run", payload: { drop: "all" } }),
    });
    assert.equal(res.status, 202, "accepted — but only as a plain wake");
    assert.equal(wakes, before + 1, "exactly one wake, carrying nothing");
  });

  it("ignores a query string trying to do the same", async () => {
    const before = wakes;
    const res = await fetch(url("/wake?jobId=j-victim&command=drop"), {
      method: "POST",
      headers: signedHeaders(),
    });
    assert.equal(res.status, 202);
    assert.equal(wakes, before + 1);
  });

  it("refuses an oversized body rather than buffering it", async () => {
    const res = await fetch(url(), {
      method: "POST",
      headers: signedHeaders(),
      body: "x".repeat(64 * 1024),
    }).catch(() => null);
    // The connection is torn down mid-upload, so either a 413 or a transport
    // failure is correct; what must not happen is the worker accepting 64KB.
    if (res) assert.ok(res.status === 413 || res.status >= 400);
  });

  it("keeps serving after a rejected request", async () => {
    await fetch(url(), { method: "POST" });
    const res = await fetch(url(), { method: "POST", headers: signedHeaders() });
    assert.equal(res.status, 202);
  });

  it("answers 429 once the rate limit is spent, distinctly from 401", async () => {
    const limited = createWakeServer({
      guard: new WakeGuard({ secret: SECRET, rateMaxPerWindow: 1 }),
      logger: silentLogger,
      host: "127.0.0.1",
      port: 0,
      onWake: () => {},
    });
    await limited.listen();
    const limitedUrl = `http://127.0.0.1:${limited.address()}/wake`;
    // This guard runs on the real clock, unlike the suite's fixed one, so the
    // credentials have to be minted against the real clock too.
    const live = (): Record<string, string> => {
      const creds = createWakeCredentials(SECRET);
      return {
        [WAKE_TIMESTAMP_HEADER]: String(creds.timestamp),
        [WAKE_NONCE_HEADER]: creds.nonce,
        [WAKE_SIGNATURE_HEADER]: creds.signature,
      };
    };
    try {
      const first = await fetch(limitedUrl, { method: "POST", headers: live() });
      assert.equal(first.status, 202);
      const second = await fetch(limitedUrl, { method: "POST", headers: live() });
      assert.equal(second.status, 429);
    } finally {
      await limited.close();
    }
  });
});

// ─── Nothing secret reaches the log ───────────────────────────────────────────

describe("wake rejection logging", () => {
  it("names the verdict and the peer, never the credentials", async () => {
    const lines: string[] = [];
    const capturing = createLogger("test", (line) => void lines.push(line));

    const server = createWakeServer({
      guard: new WakeGuard({ secret: SECRET }),
      logger: capturing,
      host: "127.0.0.1",
      port: 0,
      onWake: () => {},
    });
    await server.listen();

    try {
      const creds = createWakeCredentials("wrong-secret");
      await fetch(`http://127.0.0.1:${server.address()}/wake`, {
        method: "POST",
        headers: {
          [WAKE_TIMESTAMP_HEADER]: String(creds.timestamp),
          [WAKE_NONCE_HEADER]: creds.nonce,
          [WAKE_SIGNATURE_HEADER]: creds.signature,
        },
      });

      const serialized = lines.join("\n");
      assert.ok(serialized.includes("bad_signature"), "the verdict is logged");
      assert.ok(!serialized.includes(SECRET), "the secret is not");
      assert.ok(!serialized.includes(creds.signature), "nor the presented signature");
      assert.ok(!serialized.includes(creds.nonce), "nor the nonce");
    } finally {
      await server.close();
    }
  });
});
