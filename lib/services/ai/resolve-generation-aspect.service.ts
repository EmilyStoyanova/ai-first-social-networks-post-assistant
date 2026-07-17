import type { FeedItemContext, ILlmProvider } from "@/lib/ai/types";
import type { ContentAspect } from "@/lib/ai/content-aspect";
import { selectAspect } from "@/lib/ai/content-aspect";
import { buildPrimaryFingerprint, extractAspects } from "@/lib/ai/aspect-extractor";
import { loadAspectPoolData, allAspectsUsed } from "@/lib/ai/aspect-pool-store";

export interface ResolvedAspect {
  aspect: ContentAspect | undefined;
  pool: ContentAspect[];
  extractionRound: number;
  fingerprint: string | null;
  usedAspectIds: string[];
}

const EMPTY: ResolvedAspect = {
  aspect: undefined,
  pool: [],
  extractionRound: 0,
  fingerprint: null,
  usedAspectIds: [],
};

/**
 * Determines which content aspect to use for the next post generation.
 *
 * Scoped entirely to the PRIMARY item: the pool is keyed to it, mined from it,
 * and therefore only ever describes it. The selected aspect reaches the prompt
 * as a mandatory constraint, so it must belong to the article the post links to
 * — anything else instructs the model to write about a different article.
 *
 * - On cache miss (no pool for this primary): extracts an initial pool via the LLM.
 * - On pool exhaustion (every aspect used at least once): runs a progressive extraction
 *   round with all prior focuses as exclusions, then appends genuinely new aspects.
 * - Falls back to LRU reuse of the existing pool when no new aspects are found.
 * - Returns an empty result when there is no primary to derive a fingerprint from.
 *
 * A claimed article backs exactly one post, so its pool is normally a cold miss
 * and is mined once; the pool then feeds retries, which pick a different aspect
 * from the SAME article. Evergreen primaries are reused across posts, and that
 * is where the cache and the LRU rotation actually earn their keep.
 *
 * Errors from extraction are caught and result in EMPTY (generation proceeds without aspect).
 */
export async function resolveGenerationAspect(params: {
  primary: FeedItemContext | null;
  snapshots: Array<Record<string, unknown> | null>;
  provider: ILlmProvider;
}): Promise<ResolvedAspect> {
  const { primary, snapshots, provider } = params;

  const fingerprint = buildPrimaryFingerprint(primary);
  if (!fingerprint || !primary) return EMPTY;

  let poolData;
  try {
    poolData = loadAspectPoolData(snapshots, fingerprint);
  } catch {
    return EMPTY;
  }

  let pool: ContentAspect[];
  let round: number;

  try {
    if (poolData === null) {
      // First generation for this primary — extract the initial pool.
      const extracted = await extractAspects(provider, primary, []);
      pool = extracted;
      round = 1;
    } else if (allAspectsUsed(poolData.pool, poolData.usedAspectIds)) {
      // Pool exhausted — run a progressive extraction with all prior focuses excluded.
      const newAspects = await extractAspects(provider, primary, poolData.excludedFocuses);
      pool = newAspects.length > 0 ? [...poolData.pool, ...newAspects] : poolData.pool;
      round = poolData.extractionRound + 1;
    } else {
      pool = poolData.pool;
      round = poolData.extractionRound;
    }
  } catch {
    return EMPTY;
  }

  if (pool.length === 0) {
    return { aspect: undefined, pool, extractionRound: round, fingerprint, usedAspectIds: [] };
  }

  const usedAspectIds = poolData?.usedAspectIds ?? [];
  const aspect = selectAspect(pool, usedAspectIds);

  return { aspect, pool, extractionRound: round, fingerprint, usedAspectIds };
}
