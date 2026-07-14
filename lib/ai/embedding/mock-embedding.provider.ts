import { createHash } from "node:crypto";
import { type EmbeddingResult, type IEmbeddingProvider } from "./embedding-provider";

/**
 * Deterministic offline embedding provider for tests and AI_MOCK_MODE.
 * Produces stable `dims`-length vectors seeded from a hash of the input text, so
 * identical text always yields the identical vector and no network is touched.
 */
export class MockEmbeddingProvider implements IEmbeddingProvider {
  readonly provider = "mock";
  readonly model = "mock";

  constructor(readonly dims: number) {}

  async embed(texts: string[]): Promise<EmbeddingResult> {
    return {
      vectors: texts.map((t) => this.vectorFor(t)),
      provider: this.provider,
      model: this.model,
      dims: this.dims,
    };
  }

  private vectorFor(text: string): number[] {
    const vec = new Array<number>(this.dims);
    let seed = createHash("sha256").update(text).digest();
    let i = 0;
    // Expand the digest into `dims` pseudo-random values in [-1, 1) by re-hashing.
    while (i < this.dims) {
      for (let b = 0; b < seed.length && i < this.dims; b += 1, i += 1) {
        vec[i] = seed[b] / 128 - 1;
      }
      seed = createHash("sha256").update(seed).digest();
    }
    return vec;
  }
}
