export class LlmProviderError extends Error {
  readonly code = "LLM_PROVIDER_ERROR" as const;
  constructor(message: string) {
    super(message);
    this.name = "LlmProviderError";
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
