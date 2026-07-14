import type { ILlmProvider } from "./types";
import { parseLlmPost, type ParsedLlmPost } from "./parse-llm-post";
import {
  checkDuplicatePost,
  type DuplicateCheckResult,
  type RecentPost,
} from "./quality/duplicate-detection";
import { type SemanticDecision } from "./quality/semantic-duplicate";
import { assessCoreMessage } from "./quality/core-message-quality";
import { buildRetryUserPrompt } from "./prompt-builder";
import { type ContentAngle, selectRetryAngle } from "./content-angle";
import { type PostPattern, selectRetryPattern } from "./post-pattern";
import { type ContentAspect, selectRetryAspect } from "./content-aspect";

export const MAX_GENERATION_ATTEMPTS = 3;

// ─── Semantic duplicate gate (Phase 1.4) ──────────────────────────────────────
// The gate embeds a candidate's coreMessage and compares it against recent
// accepted embeddings. It is injected (the DB + embedding provider live in the
// service layer) so this module stays pure and testable.

export interface SemanticGateResult {
  decision: SemanticDecision;
  /** Cosine similarity to the closest neighbor; null when there is no history. */
  topSimilarity: number | null;
  matchedPostId: string | null;
  /** The repeated central claim — fed back to the LLM on a semantic retry. */
  matchedCoreMessage: string | null;
  /**
   * True when the gate could not run (no provider, embedding or lookup failed).
   * Fail-open: the candidate is accepted and the skip is surfaced for logging.
   */
  skipped: boolean;
}

export type SemanticGate = (candidate: {
  coreMessage: string | null;
}) => Promise<SemanticGateResult>;

/** Neutral result when no gate is wired — treated as "gate did not evaluate". */
const NO_SEMANTIC_GATE: SemanticGateResult = {
  decision: "accept",
  topSimilarity: null,
  matchedPostId: null,
  matchedCoreMessage: null,
  skipped: true,
};

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
  /** The dynamically mined content aspect baked into the initial baseUserPrompt. */
  initialAspect?: ContentAspect;
  /** Full aspect pool available for retry selection. */
  aspectPool?: ContentAspect[];
  /** Aspect ids already used by recent posts (most-recent-first). */
  aspectUsedIds?: string[];
}

export interface GenerationLoopResult {
  parsed: ParsedLlmPost;
  duplicateResult: DuplicateCheckResult;
  /** Semantic-duplicate evaluation of the accepted (or last) candidate. */
  semanticResult: SemanticGateResult;
  /**
   * True when the accepted (or last) candidate's coreMessage is generic praise
   * with no specific reason. It never blocks the save (fail-safe) but is a
   * retry trigger and a calibration signal (Phase 1.5).
   */
  coreMessageGeneric: boolean;
  /** Number of generation attempts actually made (1..maxAttempts). */
  attempts: number;
  /** The content angle that produced the accepted (or last) result. */
  selectedAngle?: ContentAngle;
  /** The writing pattern that produced the accepted (or last) result. */
  selectedPattern?: PostPattern;
  /** The content aspect that produced the accepted (or last) result. */
  selectedAspect?: ContentAspect;
}

/**
 * Calls the provider up to maxAttempts times, stopping as soon as the generated
 * post is neither a near-verbatim (Jaccard) duplicate of a recent post NOR a
 * SEMANTIC duplicate (coreMessage cosine ≥ threshold via the injected gate). On
 * retries, prepends an explicit instruction with a forced angle AND writing
 * pattern (hook / structure / CTA); when the retry is semantic, it also tells the
 * model which central claim was repeated and demands a substantially different
 * one. The last result is always returned, even if still flagged after all
 * attempts. Only the accepted candidate's embedding is persisted by the caller —
 * the gate never stores anything.
 */
export async function generateWithRetry(
  provider: ILlmProvider,
  systemPrompt: string,
  baseUserPrompt: string,
  recentPosts: RecentPost[],
  diversityOptions?: DiversityOptions,
  semanticGate?: SemanticGate,
  maxAttempts = MAX_GENERATION_ATTEMPTS
): Promise<GenerationLoopResult> {
  let lastParsed: ParsedLlmPost | null = null;
  let lastDuplicateResult: DuplicateCheckResult = {
    flagged: false,
    similarityScore: null,
    matchedPostId: null,
  };
  let lastSemanticResult: SemanticGateResult = NO_SEMANTIC_GATE;
  let lastCoreMessageGeneric = false;

  // Track angles, patterns, and aspects tried during this run so retries pick fresh ones.
  let currentAngle: ContentAngle | undefined = diversityOptions?.initialAngle;
  let currentPattern: PostPattern | undefined = diversityOptions?.initialPattern;
  let currentAspect: ContentAspect | undefined = diversityOptions?.initialAspect;

  const triedAngles: ContentAngle[] = currentAngle ? [currentAngle] : [];
  const triedPatterns: PostPattern[] = currentPattern ? [currentPattern] : [];
  const triedAspectIds: string[] = currentAspect ? [currentAspect.id] : [];

  let attemptsMade = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attemptsMade = attempt;
    let userPrompt = baseUserPrompt;

    if (attempt > 1 && lastParsed !== null) {
      const matchedPost = recentPosts.find((p) => p.id === lastDuplicateResult.matchedPostId);

      let retryAngle: ContentAngle | undefined;
      let retryPattern: PostPattern | undefined;
      let retryAspect: ContentAspect | undefined;

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

        if (currentAspect !== undefined && diversityOptions.aspectPool?.length) {
          const usedIds = [...(diversityOptions.aspectUsedIds ?? []), ...triedAspectIds];
          retryAspect = selectRetryAspect(currentAspect.id, diversityOptions.aspectPool, usedIds);
          currentAspect = retryAspect;
          triedAspectIds.push(retryAspect.id);
        }
      }

      // When the previous attempt was rejected as a semantic duplicate, feed the
      // repeated central claim back so the model changes the CLAIM, not the wording.
      const semanticDuplicate =
        lastSemanticResult.decision === "regenerate" && lastSemanticResult.matchedCoreMessage
          ? {
              repeatedCoreMessage: lastSemanticResult.matchedCoreMessage,
              similarity: lastSemanticResult.topSimilarity ?? 0,
            }
          : undefined;

      // When the previous attempt's central claim was generic praise, tell the
      // model to replace it with a specific, testable claim (not merely reword).
      const genericCoreMessage = lastCoreMessageGeneric
        ? { previousCoreMessage: lastParsed.coreMessage }
        : undefined;

      userPrompt = buildRetryUserPrompt(baseUserPrompt, {
        candidateText: lastParsed.text,
        matchedText: matchedPost?.text ?? "",
        similarityScore: lastDuplicateResult.similarityScore ?? 0,
        semanticDuplicate,
        genericCoreMessage,
        forcedAngle: retryAngle,
        forcedPattern: retryPattern,
        forcedAspect: retryAspect,
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
    lastSemanticResult = semanticGate
      ? await semanticGate({ coreMessage: lastParsed.coreMessage })
      : NO_SEMANTIC_GATE;
    lastCoreMessageGeneric = assessCoreMessage(lastParsed.coreMessage).generic;

    // Retry on a near-verbatim (Jaccard) hit, a semantic-duplicate "regenerate",
    // OR a generic coreMessage (broad praise hides real repetition). All three
    // are fail-safe: the last candidate is returned even if still flagged.
    const needsRetry =
      lastDuplicateResult.flagged ||
      lastSemanticResult.decision === "regenerate" ||
      lastCoreMessageGeneric;
    if (!needsRetry) break;
  }

  // lastParsed is non-null: the loop always executes at least once.
  return {
    parsed: lastParsed!,
    duplicateResult: lastDuplicateResult,
    semanticResult: lastSemanticResult,
    coreMessageGeneric: lastCoreMessageGeneric,
    attempts: attemptsMade,
    selectedAngle: currentAngle,
    selectedPattern: currentPattern,
    selectedAspect: currentAspect,
  };
}
