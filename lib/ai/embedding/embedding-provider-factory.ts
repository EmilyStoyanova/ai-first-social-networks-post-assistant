import { type IEmbeddingProvider } from "./embedding-provider";
import { MockEmbeddingProvider } from "./mock-embedding.provider";

/**
 * Embedding-provider factory — a separate axis from getLlmProvider()
 * (embeddings are not coupled to the text provider).
 *
 * This phase is fully LOCAL-FIRST: no cloud embedding provider is wired up, and
 * embeddings never depend on any third-party API key. Resolution:
 *
 *   AI_MOCK_MODE=true            → mock (deterministic, offline)
 *   EMBEDDING_PROVIDER=mock      → mock
 *   EMBEDDING_PROVIDER=worker    → reserved for the local TEXT_WORKER; the
 *                                  WorkerEmbeddingProvider is not implemented yet,
 *                                  so it reports unusable (skip cleanly).
 *   (unset / anything else)      → no active provider → embedding is skipped.
 *
 * Because no real provider is active, post generation always continues normally
 * and simply skips the best-effort embedding step. The next phase adds a
 * WorkerEmbeddingProvider backed by POST {TEXT_WORKER_URL}/embed.
 *
 * The dimension is fixed at EMBEDDING_DIMENSIONS to match the pgvector column.
 */

/** Must equal the pgvector column dimension in post_semantics.embedding. */
export const EMBEDDING_DIMENSIONS = 1536;

export class NoActiveEmbeddingProviderError extends Error {
  readonly code = "NO_ACTIVE_EMBEDDING_PROVIDER" as const;
  constructor(message?: string) {
    super(message ?? "No embedding provider is configured.");
    this.name = "NoActiveEmbeddingProviderError";
  }
}

type EmbeddingProviderName = "mock" | "worker" | "none";

function resolveProviderName(): EmbeddingProviderName {
  if (process.env.AI_MOCK_MODE === "true") return "mock";
  const raw = process.env.EMBEDDING_PROVIDER?.toLowerCase().trim();
  if (raw === "mock") return "mock";
  if (raw === "worker") return "worker";
  // Unset or unrecognized → no active provider (embedding is skipped cleanly).
  return "none";
}

function resolveDimensions(): number {
  const raw = process.env.EMBEDDING_DIMENSIONS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : EMBEDDING_DIMENSIONS;
}

/**
 * Reports the active provider without instantiating a client or requiring a key.
 * Returns null when no provider is usable (worker reserved, or none configured),
 * so callers (embed + backfill) can skip cleanly instead of throwing.
 */
export function getEmbeddingProviderInfo(): {
  provider: string;
  model: string;
  dims: number;
} | null {
  const name = resolveProviderName();
  const dims = resolveDimensions();

  switch (name) {
    case "mock":
      return { provider: "mock", model: "mock", dims };
    case "worker":
      // Reserved name — the abstraction supports it, but the
      // WorkerEmbeddingProvider is not implemented in this phase. Report
      // unusable so nothing tries to embed through it.
      return null;
    case "none":
      return null;
    default: {
      const _exhaustive: never = name;
      return _exhaustive;
    }
  }
}

/**
 * Returns a ready-to-use embedding provider.
 * Throws NoActiveEmbeddingProviderError when no provider is usable.
 */
export function getEmbeddingProvider(): IEmbeddingProvider {
  const name = resolveProviderName();
  const dims = resolveDimensions();

  switch (name) {
    case "mock":
      return new MockEmbeddingProvider(dims);

    case "worker":
      throw new NoActiveEmbeddingProviderError(
        "EMBEDDING_PROVIDER=worker is reserved but not implemented yet (WorkerEmbeddingProvider comes next). Use mock or AI_MOCK_MODE=true for now."
      );

    case "none":
      throw new NoActiveEmbeddingProviderError(
        "No embedding provider is configured. Set EMBEDDING_PROVIDER=worker (once implemented), EMBEDDING_PROVIDER=mock, or AI_MOCK_MODE=true."
      );

    default: {
      const _exhaustive: never = name;
      throw new NoActiveEmbeddingProviderError(
        `Unknown EMBEDDING_PROVIDER: "${String(_exhaustive)}".`
      );
    }
  }
}

/** Like getEmbeddingProvider() but returns null instead of throwing. */
export function getEmbeddingProviderOrNull(): IEmbeddingProvider | null {
  try {
    return getEmbeddingProvider();
  } catch (err) {
    if (err instanceof NoActiveEmbeddingProviderError) return null;
    throw err;
  }
}
