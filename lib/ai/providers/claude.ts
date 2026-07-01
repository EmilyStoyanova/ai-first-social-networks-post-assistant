import type { ILlmProvider, LlmRequest, LlmResponse } from "../types";

export class ClaudeProvider implements ILlmProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl?: string | null
  ) {}

  async generate(_request: LlmRequest): Promise<LlmResponse> {
    void _request;
    void this.apiKey;
    void this.model;
    void this.baseUrl;
    throw new Error("NOT_IMPLEMENTED: Claude API integration comes in Phase 5.B.");
  }
}
