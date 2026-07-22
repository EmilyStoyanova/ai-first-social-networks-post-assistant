import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

/**
 * Ambient request deadline (v2-9).
 *
 * The cron pipelines run under a wall-clock soft deadline, but a soft deadline is
 * only cooperative: checking `shouldStop()` between operations can never abort a
 * `fetch` already in flight. So a single slow/hung external call (LLM, image worker,
 * Cloudinary, Buffer, embedding) can run past the Vercel function cap and the whole
 * invocation returns nothing.
 *
 * This module makes the deadline ambient: the orchestrator installs a deadline for
 * the duration of a company's work, and every outbound HTTP call derives its
 * AbortSignal from the time still left before that deadline (bounded by a sensible
 * per-request maximum). No single call can consume the remaining headroom, and a
 * call started with no budget left is aborted (near-)immediately rather than run.
 *
 * Outside a deadline (the interactive/user path) every helper is a no-op: calls keep
 * their normal per-request timeout and no phase timing is recorded.
 */

export interface RequestDeadlineContext {
  /** Absolute wall-clock ms (Date.now scale) by which in-flight work must be done. */
  deadlineAtMs: number;
  /** Clock, injectable for tests. Defaults to Date.now at construction. */
  now: () => number;
  /** Accumulated wall-clock ms per named phase (llm, image, …), shared across the run. */
  phases: Record<string, number>;
}

const store = new AsyncLocalStorage<RequestDeadlineContext>();

/** Builds a fresh deadline context with an empty phase accumulator. */
export function createRequestDeadline(
  deadlineAtMs: number,
  now: () => number = Date.now
): RequestDeadlineContext {
  return { deadlineAtMs, now, phases: {} };
}

/** Runs `fn` with `ctx` installed as the ambient deadline. Reuse one ctx to accumulate phases. */
export function runInRequestDeadline<T>(ctx: RequestDeadlineContext, fn: () => T): T {
  return store.run(ctx, fn);
}

/** ms left before the deadline; +Infinity outside a deadline context. */
export function remainingBudgetMs(): number {
  const ctx = store.getStore();
  if (!ctx) return Number.POSITIVE_INFINITY;
  return ctx.deadlineAtMs - ctx.now();
}

/**
 * The timeout (ms) for one outbound request: the SMALLER of the per-request cap and
 * the time left before the deadline, never negative. Outside a deadline it is just
 * the cap. Exported (not only the signal) so it can be asserted deterministically.
 */
export function requestTimeoutMs(perRequestCapMs: number): number {
  const ctx = store.getStore();
  if (!ctx) return perRequestCapMs;
  const budget = ctx.deadlineAtMs - ctx.now();
  return Math.max(0, Math.min(perRequestCapMs, budget));
}

/** An AbortSignal for one outbound request, timed from the remaining budget. */
export function requestSignal(perRequestCapMs: number): AbortSignal {
  return AbortSignal.timeout(requestTimeoutMs(perRequestCapMs));
}

/**
 * Times `fn` and adds its wall-clock ms to the named phase on the ambient deadline.
 * A no-op wrapper (just runs `fn`) when there is no deadline, so instrumenting a
 * shared service never perturbs the interactive path or its tests.
 */
export async function recordPhase<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const ctx = store.getStore();
  if (!ctx) return fn();
  const t = performance.now();
  try {
    return await fn();
  } finally {
    ctx.phases[name] = (ctx.phases[name] ?? 0) + Math.round(performance.now() - t);
  }
}

// ─── Out-of-band race (the hard guarantee) ──────────────────────────────────────

export type Timer = (ms: number) => { promise: Promise<void>; cancel: () => void };

/** Real setTimeout timer, unref'd so it never keeps the event loop alive on its own. */
export const realTimer: Timer = (ms) => {
  let handle: ReturnType<typeof setTimeout>;
  const promise = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms);
    (handle as { unref?: () => void }).unref?.();
  });
  return { promise, cancel: () => clearTimeout(handle) };
};

/**
 * Races `work` against a timer of `ms`. Returns the work's value if it settles first,
 * else `{ timedOut: true }`. A late rejection of an abandoned `work` is swallowed so
 * it can never surface as an unhandledRejection after the timer already won.
 */
export async function raceWithTimeout<T>(
  work: Promise<T>,
  ms: number,
  timer: Timer = realTimer
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  const guarded = work.then((value) => ({ timedOut: false as const, value }));
  guarded.catch(() => {}); // abandoned work may reject later — never let it go unhandled
  const t = timer(Math.max(0, ms));
  try {
    return await Promise.race([guarded, t.promise.then(() => ({ timedOut: true as const }))]);
  } finally {
    t.cancel();
  }
}
