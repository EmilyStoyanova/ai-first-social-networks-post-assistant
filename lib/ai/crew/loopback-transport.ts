/**
 * The transport the CrewAI sidecar client dials with: `node:http`, not `fetch`.
 *
 * ── The defect this exists for ──────────────────────────────────────────────
 *
 * A live Mac run with `CREW_SIDECAR_TIMEOUT_MS=2700000` (45 minutes) failed at
 * roughly five minutes with:
 *
 *     CrewAI sidecar unreachable (UND_ERR_HEADERS_TIMEOUT)
 *     cause=Headers Timeout Error
 *
 * Node's global `fetch` is undici, and undici enforces TWO deadlines of its own
 * that have nothing to do with the caller's `AbortSignal`:
 *
 *   • `headersTimeout` — 300_000 ms by default. Measured from the end of the
 *     request to the arrival of the response's FIRST BYTE.
 *   • `bodyTimeout`    — 300_000 ms by default. Idle time between body chunks.
 *
 * The sidecar is a synchronous stdlib `http.server` handler: it runs the whole
 * Writer → Editor → QA loop and only then calls `send_response`. So it sends no
 * headers whatsoever for the entire generation. A multi-agent run at R=2 is up
 * to nine Ollama calls on a local 35B model — comfortably past five minutes —
 * and undici therefore abandons it mid-flight, on its own schedule, no matter
 * how large the configured budget is.
 *
 * The application timeout was never reached, which is why the failure looked
 * like a sidecar fault rather than a client one.
 *
 * ── Why not just raise undici's limits ──────────────────────────────────────
 *
 * `headersTimeout` and `bodyTimeout` live on a dispatcher, and the only ways to
 * set them are `setGlobalDispatcher()` — which changes the timeout behaviour of
 * every `fetch` in the process, including Buffer, Cloudinary and the Neon driver
 * — or passing a dispatcher per request, which needs `undici.Agent`. This repo
 * does not depend on `undici`, and adding a dependency to reach a class Node
 * already bundles but does not export is a poor trade for one loopback caller.
 *
 * `node:http` needs neither. It has **no headers timeout and no body timeout**;
 * `http.ClientRequest` applies a socket timeout only when one is asked for, and
 * even then it merely emits `'timeout'` rather than aborting. So the caller's
 * signal becomes the only deadline in the stack by construction, and the change
 * is confined to this one client — global `fetch` behaviour is untouched.
 *
 * ── One deadline, and it is the caller's ────────────────────────────────────
 *
 * This transport sets NO timeout of any kind. It honours `init.signal` for the
 * whole exchange — connect, headers and body — and rejects with that signal's
 * own reason, so `AbortSignal.timeout()`'s `TimeoutError` survives to the client
 * and still classifies as `timeout`. Nothing else here can end a request early.
 *
 * It also brings its own `http.Agent`, because `http.globalAgent` gained
 * `keepAlive: true` with a 5-second socket timeout in Node 19, and a pooled
 * socket shared with unrelated callers is not something a 45-minute request
 * should depend on. The agent is private to this module; installing it changes
 * nothing for the rest of the process.
 */

import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";

/**
 * undici's default `headersTimeout` and `bodyTimeout`, in ms.
 *
 * Recorded as a constant so the client can say out loud when a configured
 * budget exceeds it — the condition under which global `fetch` would silently
 * cut a request short — and so the regression test has something to assert
 * against rather than a magic number in a comment.
 */
export const UNDICI_DEFAULT_HEADERS_TIMEOUT_MS = 300_000;

/**
 * Structurally identical to the client's `FetchLike`, declared here so the
 * transport has no import back into the client at all — not even a type-only
 * one that a future refactor could turn into a cycle.
 */
export type LoopbackFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Statuses the `Response` constructor forbids a body on. */
const NULL_BODY_STATUS: ReadonlySet<number> = new Set([101, 204, 205, 304]);

/** Reason-phrase grammar. A status text outside it makes `Response` throw. */
const VALID_STATUS_TEXT = /^[\t\x20-\x7e\x80-\xff]*$/;

/**
 * The error a caller's abort should surface as.
 *
 * `AbortSignal.timeout()` sets `reason` to a `TimeoutError` DOMException, and
 * the client classifies `TimeoutError`/`AbortError` as the `timeout` failure
 * code. Passing the reason through unchanged is what keeps a genuine configured
 * timeout mapping to `timeout` instead of to `unavailable`.
 */
function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const err = new Error("The CrewAI sidecar request was aborted.");
  err.name = "AbortError";
  return err;
}

function normalizeBody(body: RequestInit["body"]): string | Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  // Loud rather than silently sending an empty body: the client sends
  // `JSON.stringify(request)` and nothing else, so anything here is a mistake.
  throw new TypeError("The CrewAI sidecar transport accepts only a string or byte body.");
}

function responseHeaders(res: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) {
      try {
        headers.append(name, one);
      } catch {
        // A header `Headers` refuses (an illegal name from a broken peer) is
        // dropped rather than failing a response whose body is what matters.
      }
    }
  }
  return headers;
}

/**
 * Builds a `FetchLike` over `node:http`.
 *
 * Response bodies are buffered whole. They are small JSON documents, and
 * buffering means the caller's single signal covers the body phase too — there
 * is no window in which headers have arrived, the deadline has been discharged,
 * and a stalled body could still hang the run.
 */
export function createLoopbackFetch(): LoopbackFetch {
  const httpAgent = new HttpAgent({ keepAlive: false });
  const httpsAgent = new HttpsAgent({ keepAlive: false });

  return (input, init = {}) =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(input);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new TypeError(
          `The CrewAI sidecar transport speaks http(s) only, not ${url.protocol}`
        );
      }

      const signal = init.signal ?? undefined;
      if (signal?.aborted) {
        reject(abortError(signal));
        return;
      }

      const headers: Record<string, string> = {};
      new Headers(init.headers ?? undefined).forEach((value, name) => {
        headers[name] = value;
      });

      const body = normalizeBody(init.body);
      if (body !== undefined && headers["content-length"] === undefined) {
        headers["content-length"] = String(Buffer.byteLength(body));
      }
      // The sidecar answers one request per connection and closes; saying so
      // keeps no socket parked in a pool between generations.
      headers["connection"] ??= "close";

      const send = url.protocol === "https:" ? httpsRequest : httpRequest;

      let settled = false;
      const finish = (act: () => void): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        act();
      };

      const req = send({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: (init.method ?? "GET").toUpperCase(),
        headers,
        agent: url.protocol === "https:" ? httpsAgent : httpAgent,
        // NO `timeout`. Deliberate, and the whole point of this module: the
        // caller's signal is the only deadline. See the header comment.
      });

      function onAbort(): void {
        const reason = abortError(signal as AbortSignal);
        // Destroy the socket so the abandoned request stops consuming one. It
        // does NOT stop the sidecar's generation — see the cancellation notes
        // in crew-sidecar.client.ts.
        req.destroy(reason);
        finish(() => reject(reason));
      }
      signal?.addEventListener("abort", onAbort, { once: true });

      req.on("error", (err) => finish(() => reject(err)));

      req.on("response", (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", (err) => finish(() => reject(err)));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status > 599) {
            finish(() =>
              reject(new Error(`The CrewAI sidecar returned an unusable HTTP status ${status}.`))
            );
            return;
          }
          const text = Buffer.concat(chunks).toString("utf8");
          const statusText =
            res.statusMessage && VALID_STATUS_TEXT.test(res.statusMessage) ? res.statusMessage : "";
          finish(() =>
            resolve(
              new Response(NULL_BODY_STATUS.has(status) || text.length === 0 ? null : text, {
                status,
                statusText,
                headers: responseHeaders(res),
              })
            )
          );
        });
      });

      if (body !== undefined) req.write(body);
      req.end();
    });
}

/**
 * The process-wide instance, created on first use.
 *
 * One agent pair rather than one per client: clients are constructed per
 * generation, and an agent per client would leak a socket pool per run.
 */
let shared: LoopbackFetch | undefined;

export function loopbackFetch(): LoopbackFetch {
  shared ??= createLoopbackFetch();
  return shared;
}
