/**
 * Embedding provider abstraction (Phase 1.2).
 *
 * Deliberately independent of the text-generation provider (ILlmProvider):
 * embeddings and completions are different capabilities with different vendors
 * (e.g. Anthropic has no embeddings API), so they must never be coupled.
 *
 * A provider turns text into fixed-dimension vectors. It also reports the
 * provider/model/dims it produced, so mixed-model vectors are never compared and
 * a dimension mismatch against the storage column can be caught before writing.
 */

export interface EmbeddingResult {
  /** One vector per input text, in the same order. */
  vectors: number[][];
  /** Stable provider identifier, e.g. "openai" or "mock". */
  provider: string;
  /** Concrete model, e.g. "text-embedding-3-small". */
  model: string;
  /** Dimension of every returned vector. */
  dims: number;
}

export interface IEmbeddingProvider {
  readonly provider: string;
  readonly model: string;
  readonly dims: number;
  /** Embeds a batch of texts. Throws EmbeddingProviderError on failure. */
  embed(texts: string[]): Promise<EmbeddingResult>;
}

export class EmbeddingProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingProviderError";
  }
}
