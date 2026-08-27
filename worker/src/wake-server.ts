/**
 * The wake listener: one HTTP endpoint whose entire vocabulary is "now".
 *
 * `POST /wake` with a valid signature sets an in-memory flag. There is no job
 * id, no payload, no query string and no second route, so there is nothing a
 * caller can ask for that the worker was not already going to do on its next
 * fallback tick. That is what keeps this proportionate: the endpoint is a
 * latency optimisation with an authentication check, not a control channel.
 *
 * It binds to loopback. Reaching it from Vercel is the tunnel's job (Tailscale
 * Funnel), which means the socket is never exposed directly and the tunnel can
 * be pulled without touching this process — at which point the worker keeps
 * working, just on its fallback interval.
 *
 * Verification, replay and rate limiting live in `lib/security/wake-auth.ts`,
 * shared with the side that signs. This file is the transport only.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

import type { Logger } from "./logger";
import {
  WAKE_NONCE_HEADER,
  WAKE_SIGNATURE_HEADER,
  WAKE_TIMESTAMP_HEADER,
  WakeGuard,
  type WakeVerdict,
} from "@/lib/security/wake-auth";

/**
 * Bytes read from a request body before the connection is dropped.
 *
 * The endpoint accepts no body at all; this exists only so a client that sends
 * one anyway gets drained rather than hanging, and so a client that sends a
 * large one cannot make the worker hold it.
 */
const MAX_BODY_BYTES = 1_024;

export interface WakeServerDeps {
  guard: WakeGuard;
  logger: Logger;
  host: string;
  port: number;
  /** Called once per authorized request. Must not throw. */
  onWake: () => void;
}

export interface WakeServer {
  listen(): Promise<void>;
  close(): Promise<void>;
  /** The bound port — differs from the configured one when 0 was requested. */
  address(): number | null;
}

/** Every rejection answers identically; only the log distinguishes them. */
function statusFor(verdict: WakeVerdict): number {
  if (verdict === "authorized") return 202;
  if (verdict === "rate_limited") return 429;
  return 401;
}

function respond(res: http.ServerResponse, status: number, body: Record<string, string>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    // Nothing here is cacheable and nothing here is for a browser.
    "cache-control": "no-store",
  });
  res.end(payload);
}

/** Read and discard the body, refusing anything oversized. */
function drain(req: http.IncomingMessage): Promise<boolean> {
  return new Promise((resolve) => {
    let seen = 0;
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    req.on("data", (chunk: Buffer) => {
      seen += chunk.length;
      if (seen > MAX_BODY_BYTES) {
        req.destroy();
        finish(false);
      }
    });
    req.on("end", () => finish(true));
    req.on("error", () => finish(false));
  });
}

export function createWakeServer(deps: WakeServerDeps): WakeServer {
  const server = http.createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Parsed against a dummy origin purely to split path from query; the origin
    // is never used, and a query string is ignored rather than honoured.
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    if (path !== "/wake") {
      await drain(req);
      respond(res, 404, { error: "not_found" });
      return;
    }
    if (req.method !== "POST") {
      await drain(req);
      respond(res, 405, { error: "method_not_allowed" });
      return;
    }

    const drained = await drain(req);
    if (!drained) {
      // The socket is already gone when the body was oversized; writing to it
      // would throw.
      if (!res.headersSent && !res.destroyed) respond(res, 413, { error: "payload_too_large" });
      return;
    }

    const header = (name: string): string | undefined => {
      const value = req.headers[name];
      return Array.isArray(value) ? value[0] : value;
    };

    const verdict = deps.guard.verify({
      timestamp: header(WAKE_TIMESTAMP_HEADER),
      nonce: header(WAKE_NONCE_HEADER),
      signature: header(WAKE_SIGNATURE_HEADER),
    });

    if (verdict !== "authorized") {
      // The verdict name and the peer, and nothing else. No secret, no
      // signature, no nonce — a rejected request must not have its own
      // credentials written to a log where they outlive their skew window.
      deps.logger.warn("wake rejected", {
        verdict,
        peer: req.socket.remoteAddress ?? "unknown",
      });
      respond(res, statusFor(verdict), { error: "unauthorized" });
      return;
    }

    try {
      deps.onWake();
    } catch (err) {
      deps.logger.error("wake handler failed", { error: String(err) });
    }
    respond(res, 202, { status: "accepted" });
  }

  return {
    listen(): Promise<void> {
      return new Promise((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        server.once("error", onError);
        server.listen(deps.port, deps.host, () => {
          server.off("error", onError);
          deps.logger.info("wake listener", { host: deps.host, port: deps.port });
          resolve();
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        // Idle keep-alive sockets would otherwise hold the close open until they
        // time out, which turns a clean shutdown into a 5-second one.
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
    address(): number | null {
      const addr = server.address();
      return addr && typeof addr === "object" ? (addr as AddressInfo).port : null;
    },
  };
}
