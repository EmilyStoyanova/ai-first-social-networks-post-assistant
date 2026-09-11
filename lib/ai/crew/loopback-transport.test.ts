import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import {
  createLoopbackFetch,
  loopbackFetch,
  UNDICI_DEFAULT_HEADERS_TIMEOUT_MS,
} from "./loopback-transport";
import {
  CrewSidecarClient,
  CrewSidecarError,
  DEFAULT_CREW_SIDECAR_TIMEOUT_MS,
} from "./crew-sidecar.client";
import type { CrewPostRequest, CrewPostResponse } from "./crew-contract";

/**
 * These run against REAL loopback HTTP servers, not a fetch double.
 *
 * The defect being guarded is a property of the transport itself — undici
 * abandoning a request after its own 300s `headersTimeout`, before the caller's
 * budget is anywhere near spent — and no injected `fetch` can express that. A
 * double would have passed happily throughout the original failure.
 *
 * Empirically, on Node 24.15 against a server that accepts and never answers:
 *
 *   [fetch]    REJECTED at 306.5s — TypeError: fetch failed /
 *              cause=HeadersTimeoutError code=UND_ERR_HEADERS_TIMEOUT
 *   [node:http] still open
 *
 * A test cannot wait 300s, so the tests below prove the same property in the
 * form that is measurable in milliseconds: the transport imposes NO deadline of
 * its own, and only the caller's signal ends a request.
 */

/** A server that accepts, reads the body, and never answers. */
function stallingServer(): { server: Server; port: Promise<number>; open: ServerResponse[] } {
  const open: ServerResponse[] = [];
  const server = createServer((req, res) => {
    req.resume();
    open.push(res);
  });
  const port = once(server.listen(0, "127.0.0.1"), "listening").then(
    () => (server.address() as { port: number }).port
  );
  return { server, port, open };
}

function passBody(overrides: Partial<CrewPostResponse> = {}): CrewPostResponse {
  return {
    status: "ok",
    candidate: {
      raw: '{"text":"a post","coreMessage":"a claim"}',
      json: { text: "a post", hashtags: [], coreMessage: "a claim" },
    },
    qa: { finalDecision: "pass", revisions: 0, repairs: 0, issues: [], routes: [] },
    agentCalls: { writer: 1, editor: 1, qa: 1 },
    latencyMs: 10,
    model: { tag: "qwen3.5:35b-a3b-q4_K_M", digest: "sha256:abc" },
    degradedStages: [],
    ...overrides,
  };
}

const REQUEST = {
  attemptContext: { attempt: 1, maxAttempts: 3, maxQaRounds: 2, previousRejection: null },
} as CrewPostRequest;

describe("createLoopbackFetch — the transport imposes no deadline of its own", () => {
  let server: Server;
  let base: string;
  const open: ServerResponse[] = [];

  before(async () => {
    const stalling = stallingServer();
    server = stalling.server;
    open.push(...stalling.open);
    base = `http://127.0.0.1:${await stalling.port}`;
  });

  after(async () => {
    for (const res of open) res.destroy();
    server.closeAllConnections?.();
    server.close();
  });

  it("keeps waiting on a server that has sent NOTHING, with no signal at all", async () => {
    // The exact shape of the live defect: no response byte for the whole
    // generation. With no signal there is nothing that may end this request, so
    // the assertion is that it is still pending after a wait long enough for
    // any per-request default to have fired.
    const inFlight = createLoopbackFetch()(`${base}/crew/post`, {
      method: "POST",
      body: "{}",
    });
    let settled = false;
    void inFlight.then(
      () => (settled = true),
      () => (settled = true)
    );
    await new Promise((r) => setTimeout(r, 750));
    assert.equal(settled, false, "the transport must not impose a deadline of its own");
  });

  it("ends a stalled request ONLY when the caller's signal fires", async () => {
    const startedAt = Date.now();
    await assert.rejects(
      createLoopbackFetch()(`${base}/crew/post`, {
        method: "POST",
        body: "{}",
        signal: AbortSignal.timeout(300),
      }),
      (err: Error) => {
        // The signal's OWN reason survives, which is what keeps the client's
        // `TimeoutError` → `timeout` classification working.
        assert.equal(err.name, "TimeoutError");
        return true;
      }
    );
    // Ended by the 300ms signal, not by something slower and hidden.
    assert.ok(Date.now() - startedAt < 3_000);
  });

  it("rejects immediately when handed an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      createLoopbackFetch()(`${base}/health`, { signal: controller.signal }),
      (err: Error) => err.name === "AbortError" || err.name === "Error"
    );
  });
});

describe("createLoopbackFetch — Response fidelity", () => {
  let server: Server;
  let base: string;

  before(async () => {
    server = createServer((req, res) => {
      req.resume();
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", busy: false }));
        return;
      }
      if (req.url === "/echo") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          res.writeHead(200, {
            "content-type": "application/json",
            "x-seen-key": String(req.headers["x-worker-api-key"]),
          });
          res.end(JSON.stringify({ method: req.method, body }));
        });
        return;
      }
      if (req.url === "/busy") {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "error", code: "unavailable", message: "crew_busy" }));
        return;
      }
      if (req.url === "/empty") {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await once(server.listen(0, "127.0.0.1"), "listening");
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(() => {
    server.closeAllConnections?.();
    server.close();
  });

  it("returns a real Response whose json() works", async () => {
    const res = await loopbackFetch()(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok", busy: false });
  });

  it("sends the method, headers and body through unchanged", async () => {
    const res = await loopbackFetch()(`${base}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-worker-api-key": "secret" },
      body: JSON.stringify({ hello: "world" }),
    });
    assert.equal(res.headers.get("x-seen-key"), "secret");
    assert.deepEqual(await res.json(), { method: "POST", body: '{"hello":"world"}' });
  });

  it("preserves a non-2xx status and its body rather than throwing", async () => {
    const res = await loopbackFetch()(`${base}/busy`);
    assert.equal(res.status, 503);
    assert.match(await res.text(), /crew_busy/);
  });

  it("handles a 204, which the Response constructor forbids a body on", async () => {
    const res = await loopbackFetch()(`${base}/empty`);
    assert.equal(res.status, 204);
    assert.equal(res.body, null);
  });

  it("refuses a non-http(s) URL", async () => {
    await assert.rejects(loopbackFetch()("file:///etc/passwd"), TypeError);
  });
});

describe("the client's timeout is the authoritative one", () => {
  it("configures a default budget far larger than undici's headers timeout", () => {
    // The arithmetic that makes the defect unavoidable with global fetch: even
    // the compile-time default is 9x undici's limit, so EVERY realistic budget
    // would have been preempted.
    assert.ok(
      DEFAULT_CREW_SIDECAR_TIMEOUT_MS > UNDICI_DEFAULT_HEADERS_TIMEOUT_MS,
      `${DEFAULT_CREW_SIDECAR_TIMEOUT_MS} must exceed ${UNDICI_DEFAULT_HEADERS_TIMEOUT_MS}`
    );
    assert.equal(DEFAULT_CREW_SIDECAR_TIMEOUT_MS, 2_700_000);
  });

  it("dials with node:http by default, and says so", () => {
    const client = new CrewSidecarClient({ url: "http://127.0.0.1:49510", apiKey: "k" });
    assert.equal(client.transport, "node:http");
  });

  it("reports an injected transport as injected", () => {
    const client = new CrewSidecarClient(
      { url: "http://127.0.0.1:49510", apiKey: "k" },
      async () => new Response("{}")
    );
    assert.equal(client.transport, "injected");
  });

  it("still refuses a non-loopback URL — the transport change did not relax it", () => {
    assert.throws(
      () => new CrewSidecarClient({ url: "http://198.51.100.7:49510", apiKey: "k" }),
      (err: unknown) => err instanceof CrewSidecarError && err.code === "not_configured"
    );
  });

  it("maps a GENUINE configured timeout to `timeout`, end to end", async () => {
    // Real server, real transport, real signal — the whole path, with a budget
    // small enough to assert in a test.
    const stalling = stallingServer();
    const port = await stalling.port;
    const client = new CrewSidecarClient({
      url: `http://127.0.0.1:${port}`,
      apiKey: "k",
      timeoutMs: 300,
    });
    await assert.rejects(
      client.generate(REQUEST),
      (err: unknown) =>
        err instanceof CrewSidecarError &&
        err.code === "timeout" &&
        // And it must not claim the sidecar stopped: nothing here cancels it.
        /not cancelled/.test(err.message)
    );
    for (const res of stalling.open) res.destroy();
    stalling.server.closeAllConnections?.();
    stalling.server.close();
  });

  it("names a TRANSPORT deadline as a distinct fault, not as an unreachable sidecar", async () => {
    // The original failure was reported as `unavailable — CrewAI sidecar
    // unreachable (UND_ERR_HEADERS_TIMEOUT)`, which sent the investigation to
    // the sidecar. If an undici-based transport is ever injected again, the
    // client must say what really happened instead.
    const client = new CrewSidecarClient(
      { url: "http://127.0.0.1:49510", apiKey: "k" },
      async () => {
        const err = new TypeError("fetch failed");
        err.cause = Object.assign(new Error("Headers Timeout Error"), {
          code: "UND_ERR_HEADERS_TIMEOUT",
        });
        throw err;
      }
    );
    await assert.rejects(client.generate(REQUEST), (err: unknown) => {
      assert.ok(err instanceof CrewSidecarError);
      // NOT `unavailable`: retrying cannot help, the transport must be fixed.
      assert.equal(err.code, "invalid_response");
      assert.match(err.message, /UND_ERR_HEADERS_TIMEOUT/);
      assert.match(err.message, /node:http/);
      return true;
    });
  });

  it("completes a request whose budget exceeds undici's limit", async () => {
    // Not a duration test — a wiring test. The budget below is one undici would
    // have capped; here it simply governs.
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(passBody()));
      });
    });
    await once(server.listen(0, "127.0.0.1"), "listening");
    const { port } = server.address() as { port: number };
    const client = new CrewSidecarClient({
      url: `http://127.0.0.1:${port}`,
      apiKey: "k",
      timeoutMs: UNDICI_DEFAULT_HEADERS_TIMEOUT_MS * 9,
    });
    const outcome = await client.generate(REQUEST);
    assert.equal(outcome.qaState, "pass");
    server.closeAllConnections?.();
    server.close();
  });
});
