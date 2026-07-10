import type { ILlmProvider } from "./types";
import { parseLlmPost, type ParsedLlmPost } from "./parse-llm-post";
import {
  checkDuplicatePost,
  type DuplicateCheckResult,
  type RecentPost,
} from "./quality/duplicate-detection";
import { buildRetryUserPrompt } from "./prompt-builder";

export const MAX_GENERATION_ATTEMPTS = 3;

export interface GenerationLoopResult {
  parsed: ParsedLlmPost;
  duplicateResult: DuplicateCheckResult;
}

/**
 * Calls the provider up to maxAttempts times, stopping as soon as the generated
 * post is not a duplicate of any entry in recentPosts. On retries, prepends an
 * explicit instruction describing the previous failure so the model takes a
 * genuinely different angle. The last result is always returned, even if still
 * flagged after all attempts.
 */
export async function generateWithRetry(
  provider: ILlmProvider,
  systemPrompt: string,
  baseUserPrompt: string,
  recentPosts: RecentPost[],
  maxAttempts = MAX_GENERATION_ATTEMPTS
): Promise<GenerationLoopResult> {
  let lastParsed: ParsedLlmPost | null = null;
  let lastDuplicateResult: DuplicateCheckResult = {
    flagged: false,
    similarityScore: null,
    matchedPostId: null,
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let userPrompt = baseUserPrompt;

    if (attempt > 1 && lastParsed !== null) {
      const matchedPost = recentPosts.find((p) => p.id === lastDuplicateResult.matchedPostId);
      userPrompt = buildRetryUserPrompt(baseUserPrompt, {
        candidateText: lastParsed.text,
        matchedText: matchedPost?.text ?? "",
        similarityScore: lastDuplicateResult.similarityScore ?? 0,
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

  // lastParsed is non-null: the loop always executes at least once
  return { parsed: lastParsed!, duplicateResult: lastDuplicateResult };
}
