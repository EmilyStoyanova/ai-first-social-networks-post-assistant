import type { ILlmProvider } from "./types";
import { parseLlmPost, type ParsedLlmPost } from "./parse-llm-post";
import {
  checkDuplicatePost,
  type DuplicateCheckResult,
  type RecentPost,
} from "./quality/duplicate-detection";
import { buildRetryUserPrompt } from "./prompt-builder";
import { type ContentAngle, selectRetryAngle } from "./content-angle";
import { type PostPattern, selectRetryPattern } from "./post-pattern";

export const MAX_GENERATION_ATTEMPTS = 3;

export interface DiversityOptions {
  /** The content angle baked into the initial baseUserPrompt. */
  initialAngle: ContentAngle;
  /** Angles used by recent posts (most-recent-first). */
  recentAngles: readonly ContentAngle[];
  /** The writing pattern baked into the initial baseUserPrompt. */
  initialPattern: PostPattern;
  /** Patterns used by recent posts (most-recent-first). */
  recentPatterns: readonly PostPattern[];
  /** Topics declared by recent posts — passed to the retry prompt for avoidance. */
  recentTopics: readonly string[];
}

export interface GenerationLoopResult {
  parsed: ParsedLlmPost;
  duplicateResult: DuplicateCheckResult;
  /** The content angle that produced the accepted (or last) result. */
  selectedAngle?: ContentAngle;
  /** The writing pattern that produced the accepted (or last) result. */
  selectedPattern?: PostPattern;
}

/**
 * Calls the provider up to maxAttempts times, stopping as soon as the generated
 * post is not a duplicate of any entry in recentPosts. On retries, prepends an
 * explicit instruction with a forced angle AND writing pattern (hook / structure /
 * CTA) so each attempt is structurally distinct. The last result is always
 * returned, even if still flagged after all attempts.
 */
export async function generateWithRetry(
  provider: ILlmProvider,
  systemPrompt: string,
  baseUserPrompt: string,
  recentPosts: RecentPost[],
  diversityOptions?: DiversityOptions,
  maxAttempts = MAX_GENERATION_ATTEMPTS
): Promise<GenerationLoopResult> {
  let lastParsed: ParsedLlmPost | null = null;
  let lastDuplicateResult: DuplicateCheckResult = {
    flagged: false,
    similarityScore: null,
    matchedPostId: null,
  };

  // Track angles and patterns tried during this run so retries pick fresh ones.
  let currentAngle: ContentAngle | undefined = diversityOptions?.initialAngle;
  let currentPattern: PostPattern | undefined = diversityOptions?.initialPattern;

  const triedAngles: ContentAngle[] = currentAngle ? [currentAngle] : [];
  const triedPatterns: PostPattern[] = currentPattern ? [currentPattern] : [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let userPrompt = baseUserPrompt;

    if (attempt > 1 && lastParsed !== null) {
      const matchedPost = recentPosts.find((p) => p.id === lastDuplicateResult.matchedPostId);

      let retryAngle: ContentAngle | undefined;
      let retryPattern: PostPattern | undefined;

      if (diversityOptions) {
        if (currentAngle !== undefined) {
          const usedAngles = [...(diversityOptions.recentAngles as ContentAngle[]), ...triedAngles];
          retryAngle = selectRetryAngle(currentAngle, usedAngles);
          currentAngle = retryAngle;
          triedAngles.push(retryAngle);
        }

        if (currentPattern !== undefined) {
          const usedPatterns = [
            ...(diversityOptions.recentPatterns as PostPattern[]),
            ...triedPatterns,
          ];
          retryPattern = selectRetryPattern(currentPattern, usedPatterns);
          currentPattern = retryPattern;
          triedPatterns.push(retryPattern);
        }
      }

      userPrompt = buildRetryUserPrompt(baseUserPrompt, {
        candidateText: lastParsed.text,
        matchedText: matchedPost?.text ?? "",
        similarityScore: lastDuplicateResult.similarityScore ?? 0,
        forcedAngle: retryAngle,
        forcedPattern: retryPattern,
      });
    }

    const response = await provider.generate({
      systemPrompt,
      userPrompt,
      temperature: 0.85,
      maxTokens: 1024,
    });

    lastParsed = parseLlmPost(response.text);
    lastDuplicateResult = checkDuplicatePost({
      candidateText: lastParsed.text,
      recentPosts,
    });

    if (!lastDuplicateResult.flagged) break;
  }

  // lastParsed is non-null: the loop always executes at least once.
  return {
    parsed: lastParsed!,
    duplicateResult: lastDuplicateResult,
    selectedAngle: currentAngle,
    selectedPattern: currentPattern,
  };
}
