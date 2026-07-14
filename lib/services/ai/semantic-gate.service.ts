import { prisma } from "@/lib/db/client";
import { type SocialChannel } from "@prisma/client";
import { type IEmbeddingProvider } from "@/lib/ai/embedding/embedding-provider";
import {
  EMBEDDING_DIMENSIONS,
  getEmbeddingProviderOrNull,
} from "@/lib/ai/embedding/embedding-provider-factory";
import {
  evaluateSemanticNeighbors,
  type SemanticNeighbor,
} from "@/lib/ai/quality/semantic-duplicate";
import { type SemanticGate, type SemanticGateResult } from "@/lib/ai/generate-with-retry";

/**
 * Builds the semantic-duplicate gate (Phase 1.4) wired to a real embedding
 * provider and the PostSemantics store. The gate embeds a candidate's
 * coreMessage and compares it against up to the latest 50 READY embeddings for
 * the same company+channel.
 *
 * FAIL-OPEN: a missing provider, an embedding failure, or a lookup failure never
 * blocks generation — the gate returns { decision: "accept", skipped: true } and
 * the caller logs that the gate was skipped.
 *
 * The gate never persists anything; only the accepted post's embedding is stored
 * later (by embed-post.service, after the post is created), so rejected retry
 * candidates leave no embedding behind.
 */

/** Compare against at most the latest N accepted embeddings. */
export const MAX_SEMANTIC_NEIGHBORS = 50;

const ACCEPT_SKIPPED: SemanticGateResult = {
  decision: "accept",
  topSimilarity: null,
  matchedPostId: null,
  matchedCoreMessage: null,
  skipped: true,
};

export interface SemanticNeighborStore {
  fetchReadyNeighbors(
    companyId: string,
    channel: SocialChannel,
    limit: number
  ): Promise<SemanticNeighbor[]>;
}

interface NeighborRow {
  post_id: string;
  core_message: string | null;
  embedding: string | null;
}

/** Parses pgvector's text form "[0.1,0.2,...]" into a number[]. */
function parseVectorLiteral(literal: string): number[] {
  const inner = literal.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (inner.length === 0) return [];
  return inner.split(",").map((v) => Number(v));
}

const prismaSemanticNeighborStore: SemanticNeighborStore = {
  async fetchReadyNeighbors(companyId, channel, limit) {
    const rows = await prisma.$queryRaw<NeighborRow[]>`
      SELECT s."post_id" AS post_id,
             p."core_message" AS core_message,
             s."embedding"::text AS embedding
      FROM "post_semantics" s
      JOIN "posts" p ON p."id" = s."post_id"
      WHERE s."company_id" = ${companyId}
        AND s."channel" = ${channel}::"SocialChannel"
        AND s."status" = 'ready'
        AND s."embedding" IS NOT NULL
      ORDER BY s."post_created_at" DESC
      LIMIT ${limit};
    `;
    return rows
      .filter((r): r is NeighborRow & { embedding: string } => r.embedding !== null)
      .map((r) => ({
        postId: r.post_id,
        coreMessage: r.core_message,
        vector: parseVectorLiteral(r.embedding),
      }));
  },
};

export interface CreateSemanticGateDeps {
  /**
   * Embedding provider. `undefined` → resolve from the factory (skip cleanly if
   * none). Pass `null` to force the "no provider" fail-open path.
   */
  provider?: IEmbeddingProvider | null;
  store?: SemanticNeighborStore;
}

export function createSemanticGate(
  companyId: string,
  channel: SocialChannel,
  deps: CreateSemanticGateDeps = {}
): SemanticGate {
  const store = deps.store ?? prismaSemanticNeighborStore;
  const provider = deps.provider !== undefined ? deps.provider : getEmbeddingProviderOrNull();

  return async ({ coreMessage }): Promise<SemanticGateResult> => {
    const core = coreMessage?.trim();
    // Nothing to compare — a clean accept, not a failure.
    if (!core) {
      return {
        decision: "accept",
        topSimilarity: null,
        matchedPostId: null,
        matchedCoreMessage: null,
        skipped: false,
      };
    }

    // No provider configured → fail open (gate skipped).
    if (!provider) return ACCEPT_SKIPPED;

    try {
      const result = await provider.embed([core]);
      const vector = result.vectors[0];
      if (
        !vector ||
        result.dims !== EMBEDDING_DIMENSIONS ||
        vector.length !== EMBEDDING_DIMENSIONS
      ) {
        throw new Error(
          `embedding dimension mismatch: got ${vector?.length ?? "none"} (expected ${EMBEDDING_DIMENSIONS})`
        );
      }

      const neighbors = await store.fetchReadyNeighbors(companyId, channel, MAX_SEMANTIC_NEIGHBORS);
      const evaluation = evaluateSemanticNeighbors(vector, neighbors);
      return { ...evaluation, skipped: false };
    } catch {
      // Embedding or lookup failed → fail open.
      return ACCEPT_SKIPPED;
    }
  };
}
