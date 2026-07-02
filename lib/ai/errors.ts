export class LlmProviderError extends Error {
  readonly code = "LLM_PROVIDER_ERROR" as const;
  constructor(message: string) {
    super(message);
    this.name = "LlmProviderError";
  }
}

export class LlmResponseParseError extends Error {
  readonly code = "LLM_RESPONSE_PARSE_ERROR" as const;
  constructor(message: string) {
    super(message);
    this.name = "LlmResponseParseError";
  }
}
