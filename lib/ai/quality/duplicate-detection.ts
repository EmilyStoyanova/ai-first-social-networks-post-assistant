export const SIMILARITY_THRESHOLD = 0.75;

export interface DuplicateCheckResult {
  flagged: boolean;
  similarityScore: number | null;
  matchedPostId: string | null;
}

export interface RecentPost {
  id: string;
  text: string;
  /**
   * Metadata for diagnostics only — never read by `checkDuplicatePost` itself,
   * which compares `text` alone. Present when the caller has it, so a flagged
   * match can be classified (sibling vs. historical) and logged without a
   * second lookup. Optional so existing callers/fixtures that only have
   * `{id, text}` keep compiling unchanged.
   */
  channel?: string;
  /** The content-group this post belongs to, if any. */
  contentGroupId?: string | null;
  /** The source article this post was written from, if any. */
  feedItemId?: string | null;
  createdAt?: Date;
}

/**
 * `\w` is ASCII-only — it matches `[A-Za-z0-9_]` and nothing else. `[^\w\s]`
 * therefore treats every Cyrillic letter as punctuation to strip, which
 * silently reduced any pure-Bulgarian sentence to an empty token set (proven:
 * "Новият смесител улеснява ежедневната употреба в банята." tokenized to
 * `[]`). Two DIFFERENT Bulgarian posts then compared as two empty sets, which
 * `jaccard` scored 1.0 — a false perfect duplicate, indistinguishable from two
 * genuinely near-identical Bulgarian posts, which hit the exact same empty set
 * and the exact same false 1.0. A mixed post fared no better: only its Latin
 * product name survived ("Смесителят Grohe Eurosmart е подходящ за малки
 * бани." kept only "grohe"/"eurosmart"), so every Bulgarian word was silently
 * dropped from the comparison it was supposedly part of.
 *
 * `\p{L}` and `\p{N}` are Unicode property escapes (require the `u` flag) that
 * match a letter/number in ANY script — Cyrillic included — so this keeps
 * exactly the same intent ("compare words, ignore punctuation") without a
 * hand-maintained list of scripts to keep in sync.
 */
function normalize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter(Boolean)
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  // Two texts with NO meaningful tokens carry no evidence either way — not of
  // being duplicates, and not of being distinct. Scoring that 1.0 (as this once
  // did, which is exactly what let the Cyrillic bug above manufacture false
  // duplicates purely from an empty-vs-empty comparison) would let a blank
  // comparison independently force a retry or an abort. 0 is the safe default:
  // `flagged` only fires at `score >= SIMILARITY_THRESHOLD`, so an
  // empty-vs-empty comparison can never trigger duplicate rejection on its own.
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function checkDuplicatePost(params: {
  candidateText: string;
  recentPosts: RecentPost[];
}): DuplicateCheckResult {
  const { candidateText, recentPosts } = params;

  if (recentPosts.length === 0) {
    return { flagged: false, similarityScore: null, matchedPostId: null };
  }

  const candidateWords = normalize(candidateText);

  let bestScore = 0;
  let bestId: string | null = null;

  for (const post of recentPosts) {
    const postWords = normalize(post.text);
    const score = jaccard(candidateWords, postWords);
    if (score > bestScore) {
      bestScore = score;
      bestId = post.id;
    }
  }

  const flagged = bestScore >= SIMILARITY_THRESHOLD;

  return {
    flagged,
    similarityScore: Math.round(bestScore * 1000) / 1000,
    matchedPostId: flagged ? bestId : null,
  };
}
