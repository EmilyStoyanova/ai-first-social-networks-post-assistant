/**
 * Authentication for the worker's wake signal.
 *
 * The wake endpoint carries no instruction. It cannot name a job, pass a
 * payload, or select a code path — the entire semantic content of a valid
 * request is "look at the queue now", and the worker would have looked anyway
 * on its fallback tick. That is deliberate: it makes the blast radius of a
 * forged request one boolean flipped a few minutes early, which is why a shared
 * secret is proportionate here where it would not be for a command channel.
 *
 * What IS worth defending is the endpoint's availability and the secret itself,
 * so three things are layered under one verdict:
 *
 *   1. a signature, so only a holder of the secret can be listened to;
 *   2. a timestamp inside that signature, so a captured request stops working;
 *   3. a nonce, so a captured request cannot be replayed inside its window.
 *
 * All state lives in memory. Deliberately — a rate limiter or a replay cache
 * backed by Postgres would query the very database this whole mechanism exists
 * to leave alone, and a wake request arriving while the worker is dormant would
 * then wake Neon before it woke the worker.
 *
 * Both ends import this file: the Next app to sign, the worker to verify.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * Version prefix inside the signed string. Present so the signing format can
 * change without a valid old signature being accepted under the new rules —
 * the version is signed, not merely declared.
 */
export const WAKE_SIGNATURE_VERSION = "v1";

/** Headers the signal travels in. No body, so nothing else needs signing. */
export const WAKE_TIMESTAMP_HEADER = "x-wake-timestamp";
export const WAKE_NONCE_HEADER = "x-wake-nonce";
export const WAKE_SIGNATURE_HEADER = "x-wake-signature";

/** How far a request's timestamp may sit from the verifier's clock. */
export const WAKE_MAX_SKEW_MS = 60_000;

/**
 * How long a spent nonce is remembered. Twice the skew window, because that is
 * exactly the span in which a captured request could still pass the clock
 * check — remembering it for less would leave a gap, for more only costs memory.
 */
export const WAKE_NONCE_TTL_MS = 2 * WAKE_MAX_SKEW_MS;

/** Fixed-window rate limit, applied before any cryptography. */
export const WAKE_RATE_WINDOW_MS = 60_000;
export const WAKE_RATE_MAX_PER_WINDOW = 60;

export interface WakeCredentials {
  timestamp: number;
  nonce: string;
  signature: string;
}

/**
 * The exact bytes signed. Contains only the version, the clock and the nonce —
 * there is no request-specific material because there is no request-specific
 * content, and adding any would turn a signal into a channel.
 */
function signedString(timestamp: number, nonce: string): string {
  return `${WAKE_SIGNATURE_VERSION}.${timestamp}.${nonce}`;
}

export function signWakePayload(secret: string, timestamp: number, nonce: string): string {
  return createHmac("sha256", secret).update(signedString(timestamp, nonce)).digest("hex");
}

/** Mint a fresh, single-use credential set for one wake request. */
export function createWakeCredentials(
  secret: string,
  now: number = Date.now(),
  nonce: string = randomUUID()
): WakeCredentials {
  const timestamp = Math.floor(now);
  return { timestamp, nonce, signature: signWakePayload(secret, timestamp, nonce) };
}

/** Constant-time comparison — same shape as `cron-auth.ts`'s. */
function safeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  // Length is not secret (a hex HMAC is always 64 chars), and timingSafeEqual
  // throws on a length mismatch, so this guard is required rather than a leak.
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Why a wake request was or was not honoured.
 *
 * Distinguished this finely for the log, not for the response: every failure
 * answers with the same status and the same body, so the endpoint never tells a
 * caller which of its guards it tripped.
 */
export type WakeVerdict =
  | "authorized"
  | "not_configured"
  | "rate_limited"
  | "malformed"
  | "expired"
  | "bad_signature"
  | "replayed";

/**
 * The three headers, as read off the wire — any may be absent.
 *
 * `timestamp` accepts a number as well as a string so a caller holding
 * `WakeCredentials` can verify them directly, without stringifying a value the
 * verifier is about to parse back anyway.
 */
export interface WakeRequestHeaders {
  timestamp: string | number | null | undefined;
  nonce: string | null | undefined;
  signature: string | null | undefined;
}

export interface WakeGuardOptions {
  /** The shared secret. An empty/missing secret disables the endpoint entirely. */
  secret: string | undefined;
  maxSkewMs?: number;
  nonceTtlMs?: number;
  rateWindowMs?: number;
  rateMaxPerWindow?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

/**
 * Stateful verifier: one per worker process.
 *
 * Holds the two things a pure function cannot — the spent-nonce set and the
 * rate-limit counter — both bounded, both in memory, neither touching the
 * database.
 */
export class WakeGuard {
  private readonly secret: string | undefined;
  private readonly maxSkewMs: number;
  private readonly nonceTtlMs: number;
  private readonly rateWindowMs: number;
  private readonly rateMaxPerWindow: number;
  private readonly now: () => number;

  /** nonce → the moment it stops being worth remembering. */
  private readonly seenNonces = new Map<string, number>();
  private windowStartedAt = 0;
  private windowCount = 0;

  constructor(options: WakeGuardOptions) {
    this.secret = options.secret && options.secret.length > 0 ? options.secret : undefined;
    this.maxSkewMs = options.maxSkewMs ?? WAKE_MAX_SKEW_MS;
    this.nonceTtlMs = options.nonceTtlMs ?? WAKE_NONCE_TTL_MS;
    this.rateWindowMs = options.rateWindowMs ?? WAKE_RATE_WINDOW_MS;
    this.rateMaxPerWindow = options.rateMaxPerWindow ?? WAKE_RATE_MAX_PER_WINDOW;
    this.now = options.now ?? Date.now;
  }

  /** Whether a secret was configured at all. */
  isConfigured(): boolean {
    return this.secret !== undefined;
  }

  /**
   * Verify one request.
   *
   * Order matters. The rate limit runs first so that flooding the endpoint
   * costs an integer increment rather than an HMAC, and the replay check runs
   * LAST — after the signature has already proved the caller holds the secret —
   * so that unauthenticated traffic can never insert into the nonce set. That
   * ordering is what keeps the cache's size a function of the rate limit rather
   * than of whatever the internet decides to send.
   */
  verify(headers: WakeRequestHeaders): WakeVerdict {
    if (this.secret === undefined) return "not_configured";

    const now = this.now();
    if (!this.admitToWindow(now)) return "rate_limited";

    const { timestamp, nonce, signature } = headers;
    if (timestamp === null || timestamp === undefined || timestamp === "") return "malformed";
    if (!nonce || !signature) return "malformed";

    const sentAt = Number(timestamp);
    if (!Number.isFinite(sentAt)) return "malformed";
    // A nonce is only ever generated by us, so anything oversized or oddly
    // shaped is refused before it can be remembered.
    if (nonce.length < 8 || nonce.length > 128) return "malformed";

    if (Math.abs(now - sentAt) > this.maxSkewMs) return "expired";

    const expected = signWakePayload(this.secret, sentAt, nonce);
    if (!safeEquals(signature, expected)) return "bad_signature";

    this.pruneNonces(now);
    if (this.seenNonces.has(nonce)) return "replayed";
    this.seenNonces.set(nonce, now + this.nonceTtlMs);

    return "authorized";
  }

  /** Fixed-window counter. Returns false once the window's budget is spent. */
  private admitToWindow(now: number): boolean {
    if (now - this.windowStartedAt >= this.rateWindowMs) {
      this.windowStartedAt = now;
      this.windowCount = 0;
    }
    this.windowCount += 1;
    return this.windowCount <= this.rateMaxPerWindow;
  }

  private pruneNonces(now: number): void {
    for (const [nonce, expiresAt] of this.seenNonces) {
      if (expiresAt <= now) this.seenNonces.delete(nonce);
    }
  }

  /** Remembered-nonce count. Exposed for tests and diagnostics only. */
  trackedNonceCount(): number {
    return this.seenNonces.size;
  }
}
