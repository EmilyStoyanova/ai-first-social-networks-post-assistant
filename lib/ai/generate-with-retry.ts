import type { ILlmProvider } from "./types";
import { parseLlmPost, type ParsedLlmPost } from "./parse-llm-post";
import {
  checkDuplicatePost,
  type DuplicateCheckResult,
  type RecentPost,
} from "./quality/duplicate-detection";
import { buildRetryUserPrompt } from "./prompt-builder";
import { type ContentAngle, selectRetryAngle } from "./content-angle";

export const MAX_GENERATION_ATTEMPTS = 3;

export interface AngleRotationOptions {
  /** The angle baked into the initial baseUserPrompt. */
  initialAngle: ContentAngle;
  /** Angles used by recent posts (most-recent-first). Used to avoid repetition on retry. */
  recentAngles: readonly ContentAngle[];
}

export interface GenerationLoopResult {
  parsed: ParsedLlmPost;
  duplicateResult: DuplicateCheckResult;
  /** The content angle that produced the accepted (or last) result. */
  selectedAngle?: ContentAngle;
}

/**
 * Calls the provider up to maxAttempts times, stopping as soon as the generated
 * post is not a duplicate of any entry in recentPosts. On retries, prepends an
 * explicit instruction describing the previous failure so the model takes a
 * genuinely different angle. The last result is always returned, even if still
 * flagged after all attempts.
 *
 * When angleOptions is provided the retry prompt forces a different content angle
 * on each attempt. The final angle used is returned in selectedAngle.
 */
export async function generateWithRetry(
  provider: ILlmProvider,
  systemPrompt: string,
  baseUserPrompt: string,
  recentPosts: RecentPost[],
  angleOptions?: AngleRotationOptions,
  maxAttempts = MAX_GENERATION_ATTEMPTS
): Promise<GenerationLoopResult> {
  let lastParsed: ParsedLlmPost | null = null;
  let lastDuplicateResult: DuplicateCheckResult = {
    flagged: false,
    similarityScore: null,
    matchedPostId: null,
  };

  // Track angles tried during this generation run so retries pick fresh ones.
  let currentAngle: ContentAngle | undefined = angleOptions?.initialAngle;
  const triedAngles: ContentAngle[] = currentAngle ? [currentAngle] : [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let userPrompt = baseUserPrompt;

    if (attempt > 1 && lastParsed !== null) {
      const matchedPost = recentPosts.find((p) => p.id === lastDuplicateResult.matchedPostId);

      let retryAngle: ContentAngle | undefined;
      if (currentAngle !== undefined && angleOptions) {
        // Combine angles from recent history with angles tried in this run so far
        // to maximise diversity on each retry attempt.
        const usedAngles = [...(angleOptions.recentAngles as ContentAngle[]), ...triedAngles];
        retryAngle = selectRetryAngle(currentAngle, usedAngles);
        currentAngle = retryAngle;
        triedAngles.push(retryAngle);
      }

      userPrompt = buildRetryUserPrompt(baseUserPrompt, {
        candidateText: lastParsed.text,
        matchedText: matchedPost?.text ?? "",
        similarityScore: lastDuplicateResult.similarityScore ?? 0,
        forcedAngle: retryAngle,
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
  return { parsed: lastParsed!, duplicateResult: lastDuplicateResult, selectedAngle: currentAngle };
}
