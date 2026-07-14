/**
 * Semantic duplicate gate (Phase 1.4) — pure comparison logic, no DB or network.
 *
 * A candidate post's coreMessage embedding is compared (cosine similarity)
 * against recent accepted embeddings for the same company+channel. This is the
 * primary duplicate signal; Jaccard remains only as a cheap near-verbatim check.
 *
 * Thresholds are INITIAL and marked for calibration:
 *   similarity  < 0.80          → accept
 *   0.80 ≤ sim  < 0.86          → accept, but flag as a gray zone (log only)
 *   similarity ≥ 0.86           → regenerate (too similar)
 */

/** Gray-zone lower bound: at/above this we accept but log for calibration. */
export const SEMANTIC_GRAY_ZONE_MIN = 0.8;
/** Regenerate bound: at/above this the candidate is a semantic duplicate. */
export const SEMANTIC_REGENERATE_MIN = 0.86;

export type SemanticDecision = "accept" | "gray_zone" | "regenerate";

/** A stored, ready embedding to compare a candidate against. */
export interface SemanticNeighbor {
  postId: string;
  /** The neighbor's coreMessage — used to tell the LLM what was repeated. */
  coreMessage: string | null;
  vector: number[];
}

export interface SemanticEvaluation {
  decision: SemanticDecision;
  /** Cosine similarity to the closest neighbor, rounded; null when no history. */
  topSimilarity: number | null;
  matchedPostId: string | null;
  matchedCoreMessage: string | null;
}

/**
 * Cosine similarity of two equal-length vectors, in [-1, 1]. Returns 0 when
 * either vector has zero magnitude (undefined direction).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: dimension mismatch (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Maps a top similarity (or null for no history) to the accept/regenerate decision. */
export function decisionFor(topSimilarity: number | null): SemanticDecision {
  if (topSimilarity === null) return "accept";
  if (topSimilarity >= SEMANTIC_REGENERATE_MIN) return "regenerate";
  if (topSimilarity >= SEMANTIC_GRAY_ZONE_MIN) return "gray_zone";
  return "accept";
}

/**
 * Finds the closest neighbor by cosine similarity and derives a decision.
 * Neighbors whose dimension does not match the candidate are skipped (a mixed
 * dimension means a different model — never comparable). No neighbors → accept.
 */
export function evaluateSemanticNeighbors(
  candidateVector: number[],
  neighbors: SemanticNeighbor[]
): SemanticEvaluation {
  let bestScore = -Infinity;
  let bestId: string | null = null;
  let bestCore: string | null = null;

  for (const neighbor of neighbors) {
    if (neighbor.vector.length !== candidateVector.length) continue;
    const score = cosineSimilarity(candidateVector, neighbor.vector);
    if (score > bestScore) {
      bestScore = score;
      bestId = neighbor.postId;
      bestCore = neighbor.coreMessage;
    }
  }

  if (bestId === null || bestScore === -Infinity) {
    return {
      decision: "accept",
      topSimilarity: null,
      matchedPostId: null,
      matchedCoreMessage: null,
    };
  }

  const topSimilarity = Math.round(bestScore * 1000) / 1000;
  return {
    decision: decisionFor(topSimilarity),
    topSimilarity,
    matchedPostId: bestId,
    matchedCoreMessage: bestCore,
  };
}
