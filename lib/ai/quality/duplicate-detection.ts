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

function normalize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
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
