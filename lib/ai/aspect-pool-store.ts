import type { ContentAspect } from "./content-aspect";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AspectPoolData {
  pool: ContentAspect[];
  /** Ordered most-recent-first — tracks which aspects have been selected. */
  usedAspectIds: string[];
  extractionRound: number;
  /** All focuses ever extracted across all rounds — passed as exclusions to the next round. */
  excludedFocuses: string[];
}

/** Fields written into Post.promptSnapshot for every generated post that has an aspect. */
export interface AspectSnapshotFields {
  aspectFingerprint: string;
  aspectPool: ContentAspect[];
  selectedAspect: ContentAspect;
  aspectUsedAt: string;
  aspectExtractionRound: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isContentAspect(v: unknown): v is ContentAspect {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.title === "string" &&
    typeof r.focus === "string" &&
    typeof r.visualConcept === "string"
  );
}

function hasAspectFields(snap: Record<string, unknown>): boolean {
  return (
    typeof snap.aspectFingerprint === "string" &&
    Array.isArray(snap.aspectPool) &&
    isContentAspect(snap.selectedAspect)
  );
}

// ─── Pool loading ─────────────────────────────────────────────────────────────

/**
 * Reconstructs aspect pool data from recent post snapshots.
 * Snapshots must be ordered most-recent-first.
 * Returns null on a cold cache miss (no snapshot matches the fingerprint),
 * which is also the correct result for legacy posts that pre-date this feature.
 */
export function loadAspectPoolData(
  snapshots: Array<Record<string, unknown> | null>,
  fingerprint: string
): AspectPoolData | null {
  const matching = snapshots.filter(
    (s): s is Record<string, unknown> =>
      s !== null && hasAspectFields(s) && s.aspectFingerprint === fingerprint
  );

  if (matching.length === 0) return null;

  // The most recent snapshot holds the canonical pool (all prior rounds appended into it).
  const canonicalPool = (matching[0].aspectPool as ContentAspect[]).filter(isContentAspect);

  const usedAspectIds: string[] = [];
  const excludedFocuses: string[] = [];
  let maxRound = 1;

  for (const snap of matching) {
    const selected = snap.selectedAspect as ContentAspect;
    usedAspectIds.push(selected.id);
    if (!excludedFocuses.includes(selected.focus)) {
      excludedFocuses.push(selected.focus);
    }
    const round = typeof snap.aspectExtractionRound === "number" ? snap.aspectExtractionRound : 1;
    if (round > maxRound) maxRound = round;
  }

  // Include all pool focuses in exclusions so later rounds don't re-mine the same angles.
  for (const aspect of canonicalPool) {
    if (!excludedFocuses.includes(aspect.focus)) {
      excludedFocuses.push(aspect.focus);
    }
  }

  return {
    pool: canonicalPool,
    usedAspectIds,
    extractionRound: maxRound,
    excludedFocuses,
  };
}

// ─── Pool state helpers ───────────────────────────────────────────────────────

export function allAspectsUsed(pool: ContentAspect[], usedIds: string[]): boolean {
  return pool.length > 0 && pool.every((a) => usedIds.includes(a.id));
}

export function buildSnapshotAspectFields(
  fingerprint: string,
  pool: ContentAspect[],
  selectedAspect: ContentAspect,
  extractionRound: number
): AspectSnapshotFields {
  return {
    aspectFingerprint: fingerprint,
    aspectPool: pool,
    selectedAspect,
    aspectUsedAt: new Date().toISOString(),
    aspectExtractionRound: extractionRound,
  };
}
