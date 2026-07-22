/** Exponential backoff with jitter for job retries. Pure and injectable-random. */

export interface BackoffOptions {
  /** Delay for the first retry (attempt 1). Default 1000ms. */
  baseMs?: number;
  /** Growth factor per attempt. Default 2. */
  factor?: number;
  /** Ceiling before jitter. Default 300000ms (5 min). */
  maxMs?: number;
  /** Symmetric jitter as a fraction of the delay (0..1). Default 0.2. */
  jitter?: number;
  /** Injectable RNG in [0,1) for deterministic tests. Default Math.random. */
  random?: () => number;
}

/**
 * Delay before retrying the Nth attempt (attempt >= 1):
 *   min(baseMs * factor^(attempt-1), maxMs), then ± jitter.
 * Never negative.
 */
export function computeBackoffMs(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? 1_000;
  const factor = opts.factor ?? 2;
  const max = opts.maxMs ?? 300_000;
  const jitter = opts.jitter ?? 0.2;
  const rand = opts.random ?? Math.random;

  const exponent = Math.max(0, attempt - 1);
  const capped = Math.min(base * Math.pow(factor, exponent), max);
  const delta = capped * jitter * (rand() * 2 - 1);
  return Math.max(0, Math.round(capped + delta));
}
