/**
 * Errors specific to the analytics path (v2-7). Kept apart from buffer-errors.ts
 * because these describe failures of the Personal API Key, not of the OAuth
 * connection that publishing uses — conflating them would let an analytics
 * problem read as "your Buffer connection is broken" and send an owner off to
 * reconnect Buffer, which would not help.
 */

/** No Personal API Key is configured for this company. Analytics are disabled. */
export class AnalyticsNoKeyError extends Error {
  constructor() {
    super("No Buffer Personal API Key is configured for this company.");
    this.name = "AnalyticsNoKeyError";
  }
}

/** The key was rejected outright — revoked, mistyped, or never valid. */
export class AnalyticsKeyInvalidError extends Error {
  constructor(message = "The Buffer Personal API Key was rejected.") {
    super(message);
    this.name = "AnalyticsKeyInvalidError";
  }
}

/**
 * The key authenticates but lacks `insights:read`.
 *
 * Not expected in practice — a Personal API Key was verified to carry the scope
 * (2026-07-20) — but Buffer could change that, and this failure must stay
 * distinguishable from a bad key so the UI does not tell an owner to re-enter a
 * key that is actually fine.
 */
export class AnalyticsScopeError extends Error {
  constructor(message = "This Buffer key does not grant access to insights.") {
    super(message);
    this.name = "AnalyticsScopeError";
  }
}

/** Buffer's rate limit was hit. The caller should stop and retry on the next run. */
export class AnalyticsRateLimitError extends Error {
  constructor(message = "Buffer rate limit reached.") {
    super(message);
    this.name = "AnalyticsRateLimitError";
  }
}
