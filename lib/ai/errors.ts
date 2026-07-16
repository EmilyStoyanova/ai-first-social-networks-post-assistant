export class LlmProviderError extends Error {
  readonly code = "LLM_PROVIDER_ERROR" as const;
  constructor(message: string) {
    super(message);
    this.name = "LlmProviderError";
  }
}

/**
 * The provider rejected the request because we are over its rate limit (HTTP 429
 * / rate_limit_exceeded), and the provider's own bounded retries were exhausted.
 *
 * Extends LlmProviderError so callers that only handle the generic case still
 * degrade safely; handlers that care must test for this subclass FIRST, since
 * `instanceof LlmProviderError` also matches it.
 *
 * We never respond to a rate limit by switching provider or model — the caller
 * chose that model explicitly, so we surface the limit instead.
 */
export class LlmRateLimitError extends LlmProviderError {
  readonly rateLimited = true as const;
  /** Provider-advertised wait from Retry-After, when it sent one. */
  readonly retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = "LlmRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Distinguishes the two ways an LLM response can fail parsing, for diagnostics:
 *   • INVALID_JSON            — the text was not valid JSON at all
 *   • MISSING_OR_INVALID_FIELDS — valid JSON, but failed the schema (e.g. a
 *                                 missing/empty required coreMessage)
 */
export type LlmParseErrorCategory = "INVALID_JSON" | "MISSING_OR_INVALID_FIELDS";

export class LlmResponseParseError extends Error {
  readonly code = "LLM_RESPONSE_PARSE_ERROR" as const;
  /** Diagnostic-only; does not affect error handling or the mapped HTTP status. */
  readonly category?: LlmParseErrorCategory;
  constructor(message: string, category?: LlmParseErrorCategory) {
    super(message);
    this.name = "LlmResponseParseError";
    this.category = category;
  }
}
