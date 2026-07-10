import type { FeedItemContext, ILlmProvider } from "@/lib/ai/types";
import type { ContentAspect } from "@/lib/ai/content-aspect";
import { selectAspect } from "@/lib/ai/content-aspect";
import { buildContextFingerprint, extractAspects } from "@/lib/ai/aspect-extractor";
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
 * - On cache miss (no pool for this fingerprint): extracts an initial pool via the LLM.
 * - On pool exhaustion (every aspect used at least once): runs a progressive extraction
 *   round with all prior focuses as exclusions, then appends genuinely new aspects.
 * - Falls back to LRU reuse of the existing pool when no new aspects are found.
 * - Returns an empty result when there are no feed items to derive a fingerprint from.
 *
 * Errors from extraction are caught and result in EMPTY (generation proceeds without aspect).
 */
export async function resolveGenerationAspect(params: {
  feedItems: FeedItemContext[];
  snapshots: Array<Record<string, unknown> | null>;
  provider: ILlmProvider;
}): Promise<ResolvedAspect> {
  const { feedItems, snapshots, provider } = params;

  const fingerprint = buildContextFingerprint(feedItems);
  if (!fingerprint) return EMPTY;

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
      // First generation for this content fingerprint — extract the initial pool.
      const extracted = await extractAspects(provider, feedItems, []);
      pool = extracted;
      round = 1;
    } else if (allAspectsUsed(poolData.pool, poolData.usedAspectIds)) {
      // Pool exhausted — run a progressive extraction with all prior focuses excluded.
      const newAspects = await extractAspects(provider, feedItems, poolData.excludedFocuses);
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
