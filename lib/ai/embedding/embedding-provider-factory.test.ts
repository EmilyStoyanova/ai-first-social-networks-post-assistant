import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EMBEDDING_DIMENSIONS,
  NoActiveEmbeddingProviderError,
  getEmbeddingProvider,
  getEmbeddingProviderInfo,
  getEmbeddingProviderOrNull,
} from "./embedding-provider-factory";

// Snapshot and restore the env keys this factory reads, so tests are isolated.
const KEYS = [
  "AI_MOCK_MODE",
  "EMBEDDING_PROVIDER",
  "EMBEDDING_DIMENSIONS",
  "TEXT_WORKER_URL",
  "TEXT_WORKER_API_KEY",
] as const;

describe("embedding-provider-factory", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("returns the deterministic mock provider under AI_MOCK_MODE", async () => {
    process.env.AI_MOCK_MODE = "true";

    const info = getEmbeddingProviderInfo();
    assert.deepEqual(info, { provider: "mock", model: "mock", dims: EMBEDDING_DIMENSIONS });

    const provider = getEmbeddingProvider();
    const { vectors, dims } = await provider.embed(["hello"]);
    assert.equal(dims, EMBEDDING_DIMENSIONS);
    assert.equal(vectors[0].length, EMBEDDING_DIMENSIONS);

    // Deterministic: same text → identical vector.
    const again = await provider.embed(["hello"]);
    assert.deepEqual(again.vectors[0], vectors[0]);
    // Different text → different vector.
    const other = await provider.embed(["world"]);
    assert.notDeepEqual(other.vectors[0], vectors[0]);
  });

  it("returns the mock provider when EMBEDDING_PROVIDER=mock (without AI_MOCK_MODE)", () => {
    process.env.EMBEDDING_PROVIDER = "mock";

    assert.deepEqual(getEmbeddingProviderInfo(), {
      provider: "mock",
      model: "mock",
      dims: EMBEDDING_DIMENSIONS,
    });
    assert.ok(getEmbeddingProviderOrNull());
  });

  it("returns the worker provider when EMBEDDING_PROVIDER=worker and the worker is configured", () => {
    process.env.EMBEDDING_PROVIDER = "worker";
    process.env.TEXT_WORKER_URL = "http://worker.local:3002";
    process.env.TEXT_WORKER_API_KEY = "secret";

    assert.deepEqual(getEmbeddingProviderInfo(), {
      provider: "worker",
      model: "bge-m3",
      dims: EMBEDDING_DIMENSIONS,
    });

    const provider = getEmbeddingProvider();
    assert.equal(provider.provider, "worker");
    assert.equal(provider.model, "bge-m3");
    assert.equal(provider.dims, EMBEDDING_DIMENSIONS);
    assert.ok(getEmbeddingProviderOrNull());
  });

  it("treats worker as unusable when TEXT_WORKER_URL/API_KEY are missing", () => {
    process.env.EMBEDDING_PROVIDER = "worker";
    // No TEXT_WORKER_URL / TEXT_WORKER_API_KEY → skip cleanly.

    assert.equal(getEmbeddingProviderInfo(), null);
    assert.equal(getEmbeddingProviderOrNull(), null);
    assert.throws(() => getEmbeddingProvider(), NoActiveEmbeddingProviderError);
  });

  it("reports no active provider when none is configured", () => {
    // No AI_MOCK_MODE, no EMBEDDING_PROVIDER → embedding skips cleanly.
    assert.equal(getEmbeddingProviderInfo(), null);
    assert.equal(getEmbeddingProviderOrNull(), null);
    assert.throws(() => getEmbeddingProvider(), NoActiveEmbeddingProviderError);
  });
});
