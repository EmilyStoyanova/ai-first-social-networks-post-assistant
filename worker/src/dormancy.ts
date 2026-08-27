/**
 * When an empty queue stops being worth polling.
 *
 * Pure, so the one decision that governs the worker's entire database cost can
 * be read and tested without a clock, a socket, or a Postgres.
 */

export interface IdleContext {
  /** When the current run of empty claims began. */
  emptySinceMs: number;
  nowMs: number;
  /** Quiet time before going dormant; `0` disables dormancy. */
  dormantAfterMs: number;
  pollIntervalMs: number;
}

export type IdleDecision =
  { action: "poll"; sleepMs: number } | { action: "dormant"; quietMs: number };

/**
 * What to do after a claim came back empty.
 *
 * Two states, not a curve. A backoff that stretches the interval out would look
 * like the obvious answer and is the wrong one: a suspended database is woken by
 * ANY query, so the cost of polling is set by whether the gaps ever exceed the
 * suspend threshold, not by how many queries are sent. Ten-minute polling and
 * two-second polling both keep compute running; only stopping stops it.
 */
export function decideIdleAction(context: IdleContext): IdleDecision {
  const { emptySinceMs, nowMs, dormantAfterMs, pollIntervalMs } = context;

  if (dormantAfterMs <= 0) return { action: "poll", sleepMs: pollIntervalMs };

  const quietMs = Math.max(0, nowMs - emptySinceMs);
  if (quietMs >= dormantAfterMs) return { action: "dormant", quietMs };

  // Never sleep past the moment dormancy is due — otherwise a poll interval
  // longer than the remaining quiet time would overshoot it by a whole tick.
  const remainingMs = dormantAfterMs - quietMs;
  return { action: "poll", sleepMs: Math.min(pollIntervalMs, remainingMs) };
}
