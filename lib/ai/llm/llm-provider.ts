// Re-export the provider interface and request/response types from the canonical location.
// New code in lib/ai/llm/ should import from here for colocation.
export type { ILlmProvider, LlmRequest, LlmResponse } from "../types";
