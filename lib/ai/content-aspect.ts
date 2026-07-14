import { createHash } from "node:crypto";

export interface ContentAspect {
  id: string;
  title: string;
  focus: string;
  visualConcept: string;
}

export function normalizeAspectFocus(focus: string): string {
  return focus.trim().toLowerCase().replace(/\s+/g, " ");
}

export function aspectId(focus: string): string {
  return createHash("sha256").update(normalizeAspectFocus(focus)).digest("hex").slice(0, 8);
}

// Ignore very short words when comparing focuses for similarity
function wordSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2)
  );
}

export function jaccardSimilarity(a: string, b: string): number {
  const sa = wordSet(a);
  const sb = wordSet(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let intersection = 0;
  for (const w of sa) {
    if (sb.has(w)) intersection++;
  }
  return intersection / (sa.size + sb.size - intersection);
}

export function isGenericFocus(focus: string): boolean {
  const norm = normalizeAspectFocus(focus);
  if (!norm) return true;
  const words = norm.split(" ").filter(Boolean);
  if (words.length < 3) return true;
  const GENERIC =
    /^(overview|introduction|summary|general information|about the (company|brand|product|service)|miscellaneous|other content|various topics?|the main (topic|subject|theme))$/;
  // Broad praise themes (anchored — only when the WHOLE focus is the platitude,
  // so a narrow focus that merely contains "great for" is unaffected). Keeps the
  // aspect pool made of distinct facts/benefits/problems rather than mood.
  const GENERIC_PRAISE =
    /^(?:(?:great|good|perfect|ideal|fun)\s+for\s+[\w\s]+|something\s+for\s+everyone|a\s+(?:must[-\s]?visit|dream)\s+[\w\s]+)$/;
  return GENERIC.test(norm) || GENERIC_PRAISE.test(norm);
}

export function tooSimilarToExisting(
  focus: string,
  existingFocuses: string[],
  threshold = 0.55
): boolean {
  const norm = normalizeAspectFocus(focus);
  for (const existing of existingFocuses) {
    if (jaccardSimilarity(norm, normalizeAspectFocus(existing)) >= threshold) return true;
  }
  return false;
}

export function validateAspects(raw: unknown[], existingFocuses: string[] = []): ContentAspect[] {
  const acceptedNorms: string[] = [];
  const result: ContentAspect[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (
      typeof r.title !== "string" ||
      typeof r.focus !== "string" ||
      typeof r.visualConcept !== "string"
    )
      continue;

    const title = r.title.trim();
    const focus = r.focus.trim();
    const visualConcept = r.visualConcept.trim();

    if (!title || !focus || !visualConcept) continue;
    if (isGenericFocus(focus)) continue;

    const norm = normalizeAspectFocus(focus);

    // Exact duplicate within this batch
    if (acceptedNorms.some((n) => n === norm)) continue;

    // Too similar to existing pool (from prior rounds)
    if (tooSimilarToExisting(focus, existingFocuses)) continue;

    // Too similar to already-accepted in this batch
    if (tooSimilarToExisting(focus, acceptedNorms)) continue;

    acceptedNorms.push(norm);
    result.push({ id: aspectId(focus), title, focus, visualConcept });
  }

  return result;
}

/**
 * Prefers never-used aspects; otherwise picks the least recently used (LRU).
 * usedIds is ordered most-recent-first (index 0 = most recently used).
 */
export function selectAspect(pool: ContentAspect[], usedIds: readonly string[]): ContentAspect {
  for (const aspect of pool) {
    if (!usedIds.includes(aspect.id)) return aspect;
  }
  // All used: pick the aspect whose id appears deepest (largest indexOf = oldest use)
  let best = pool[0];
  let bestIdx = usedIds.indexOf(pool[0].id);
  for (let i = 1; i < pool.length; i++) {
    const idx = usedIds.indexOf(pool[i].id);
    if (idx > bestIdx) {
      bestIdx = idx;
      best = pool[i];
    }
  }
  return best;
}

/**
 * Picks a retry aspect that differs from currentId.
 * Prefers never-used; falls back to LRU excluding current.
 */
export function selectRetryAspect(
  currentId: string,
  pool: ContentAspect[],
  usedIds: readonly string[]
): ContentAspect {
  for (const aspect of pool) {
    if (aspect.id !== currentId && !usedIds.includes(aspect.id)) return aspect;
  }
  let best: ContentAspect | null = null;
  let bestIdx = -1;
  for (const aspect of pool) {
    if (aspect.id === currentId) continue;
    const idx = usedIds.indexOf(aspect.id);
    if (idx > bestIdx) {
      bestIdx = idx;
      best = aspect;
    }
  }
  return best ?? pool[0];
}
