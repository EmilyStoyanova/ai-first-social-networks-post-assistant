import type { ILlmProvider } from "./types";
import { parseLlmPost, type ParsedLlmPost } from "./parse-llm-post";
import { LlmResponseParseError } from "./errors";
import {
  checkDuplicatePost,
  type DuplicateCheckResult,
  type RecentPost,
} from "./quality/duplicate-detection";
import { type SemanticDecision } from "./quality/semantic-duplicate";
import { assessCoreMessage } from "./quality/core-message-quality";
import {
  validateGenerationCompliance,
  NO_COMPLIANCE_CHECK,
  type ComplianceResult,
  type ComplianceDimension,
} from "./quality/generation-compliance";
import { buildRetryUserPrompt } from "./prompt-builder";
import { type ContentAngle, selectRetryAngle } from "./content-angle";
import { type PostPattern, selectRetryPattern } from "./post-pattern";
import { type ContentAspect, selectRetryAspect } from "./content-aspect";
import { isTopicRepeated } from "./topic-memory";
import type {
  AttemptRejectionReason,
  GenerationAttemptRecorder,
} from "@/lib/generation-trace/attempt-record";

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
  /** The candidate's declared topic — enriches the embedded document when present. */
  topic?: string | null;
  /** The aspect focus used for this candidate — enriches the embedded document. */
  aspectFocus?: string | null;
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
  /**
   * Topic Memory — normalized topic keys from recent posts (most-recent-first).
   * Doubles as the prompt's avoid-list and the gate that rejects a candidate
   * whose normalized topic collides with one already used. Expected to hold
   * normalized keys (see buildTopicMemory); the candidate is normalized on check.
   */
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
  /**
   * True when the accepted (or last) candidate's normalized topic collided with
   * the topic memory. Like the other triggers it never blocks the save — it is a
   * retry trigger and a diagnostic signal (Topic Memory).
   */
  topicRepeated: boolean;
  /**
   * Post-generation compliance gate: whether the accepted (or last) candidate's
   * text is free of banned terms (e.g. "Стоп"). It runs on every candidate,
   * with or without an angle/pattern.
   *
   * It does NOT re-verify the angle/hook/structure/CTA the candidate was
   * generated under — those are prompt guidance and can never fail here (see
   * generation-compliance.ts).
   *
   * Only `status === "failed"` is a retry trigger, and only it is fatal to the
   * caller — the generation service refuses to persist a post that still
   * carries a banned term (POST_FAILED_COMPLIANCE).
   */
  complianceResult: ComplianceResult;
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
 *
 * `recorder`, when given, is told about EVERY attempt as it completes — including
 * the ones this function discards. It is observation only: it is called inside a
 * try/catch, its return value is ignored, and nothing in the loop branches on
 * whether it is present. See lib/generation-trace/attempt-record.ts.
 */
export async function generateWithRetry(
  provider: ILlmProvider,
  systemPrompt: string,
  baseUserPrompt: string,
  recentPosts: RecentPost[],
  diversityOptions?: DiversityOptions,
  semanticGate?: SemanticGate,
  maxAttempts = MAX_GENERATION_ATTEMPTS,
  recorder?: GenerationAttemptRecorder
): Promise<GenerationLoopResult> {
  let lastParsed: ParsedLlmPost | null = null;
  let lastDuplicateResult: DuplicateCheckResult = {
    flagged: false,
    similarityScore: null,
    matchedPostId: null,
  };
  let lastSemanticResult: SemanticGateResult = NO_SEMANTIC_GATE;
  let lastCoreMessageGeneric = false;
  let lastTopicRepeated = false;
  let lastComplianceResult: ComplianceResult = NO_COMPLIANCE_CHECK;
  let lastRejectionReason: AttemptRejectionReason | null = null;

  // Track angles, patterns, and aspects tried during this run so retries pick fresh ones.
  let currentAngle: ContentAngle | undefined = diversityOptions?.initialAngle;
  let currentPattern: PostPattern | undefined = diversityOptions?.initialPattern;
  let currentAspect: ContentAspect | undefined = diversityOptions?.initialAspect;

  const triedAngles: ContentAngle[] = currentAngle ? [currentAngle] : [];
  const triedPatterns: PostPattern[] = currentPattern ? [currentPattern] : [];
  const triedAspectIds: string[] = currentAspect ? [currentAspect.id] : [];

  let attemptsMade = 0;

  /**
   * Hands one attempt to the recorder, if there is one.
   *
   * Wrapped because an observer must not be able to break the thing it observes:
   * a recorder that throws (a serialization bug, a full disk behind it) would
   * otherwise abort a generation that was going perfectly well.
   */
  const report = (record: Parameters<GenerationAttemptRecorder>[0]) => {
    if (!recorder) return;
    try {
      recorder(record);
    } catch (err) {
      console.error(
        "[generation-trace] Attempt recorder threw (generation continues):",
        err instanceof Error ? err.message : err
      );
    }
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attemptsMade = attempt;
    let userPrompt = baseUserPrompt;

    if (attempt > 1 && lastParsed !== null) {
      const matchedPost = recentPosts.find((p) => p.id === lastDuplicateResult.matchedPostId);

      let retryAngle: ContentAngle | undefined;
      let retryPattern: PostPattern | undefined;
      let retryAspect: ContentAspect | undefined;

      // A retry caused ONLY by a failed compliance check (i.e. a banned term)
      // must not rotate the angle/pattern/aspect — none of them caused the
      // violation, so switching them would churn the post for no reason while
      // the offending word is what has to go. Every other retry reason keeps
      // rotating exactly as before.
      const rotateDiversity = lastRejectionReason !== "compliance_failed";

      if (diversityOptions && rotateDiversity) {
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

      // When the previous attempt reused a recent topic, name it so the model
      // picks a genuinely different subject (Topic Memory).
      const repeatedTopic = lastTopicRepeated && lastParsed.topic ? lastParsed.topic : undefined;

      // When the previous attempt failed the compliance gate, name exactly what
      // it violated so the model can fix it directly.
      const complianceFailure =
        lastComplianceResult.status === "failed"
          ? { reasons: lastComplianceResult.reasons, failures: lastComplianceResult.failures }
          : undefined;

      userPrompt = buildRetryUserPrompt(baseUserPrompt, {
        candidateText: lastParsed.text,
        matchedText: matchedPost?.text ?? "",
        similarityScore: lastDuplicateResult.similarityScore ?? 0,
        semanticDuplicate,
        genericCoreMessage,
        repeatedTopic,
        complianceFailure,
        forcedAngle: retryAngle,
        forcedPattern: retryPattern,
        forcedAspect: retryAspect,
      });
    }

    // Diagnostic: mark the start of each attempt so the worker-status lines
    // (logged by the provider) can be attributed to a specific attempt.
    console.info(`[llm-diag] generation attempt ${attempt}/${maxAttempts}`);

    const request = { systemPrompt, userPrompt, temperature: 0.85, maxTokens: 1024 };
    const attemptStartedAt = new Date();

    /** The half of an attempt record that is known before the call returns. */
    const attemptBase = () => ({
      attempt,
      maxAttempts,
      systemPrompt,
      userPrompt,
      request: { temperature: request.temperature, maxTokens: request.maxTokens },
      startedAt: attemptStartedAt,
      completedAt: new Date(),
      durationMs: Date.now() - attemptStartedAt.getTime(),
      angle: currentAngle,
      pattern: currentPattern,
      aspect: currentAspect,
    });

    let response: Awaited<ReturnType<typeof provider.generate>>;
    try {
      response = await provider.generate(request);
    } catch (err) {
      // A transport/provider failure ends the whole loop (it always did — this
      // only makes sure the attempt that died is still on the record, since the
      // throw below means nothing downstream will ever see it).
      report({
        ...attemptBase(),
        rawResponse: null,
        parsed: null,
        error: {
          name: err instanceof Error ? err.name : "Error",
          message: err instanceof Error ? err.message : String(err),
        },
        accepted: false,
        rejectionReason: "provider_error" satisfies AttemptRejectionReason,
        willRetry: false,
      });
      throw err;
    }

    // Diagnostic: classify a parse failure (invalid JSON vs. missing/invalid
    // fields such as an absent coreMessage) before it propagates to the 502
    // mapping. Only the category and raw length are logged — never the content.
    try {
      lastParsed = parseLlmPost(response.text);
    } catch (err) {
      if (err instanceof LlmResponseParseError) {
        console.warn(
          `[llm-diag] attempt ${attempt} parse failed: category=${
            err.category ?? "unknown"
          } rawLength=${response.text.length}`
        );
      }
      report({
        ...attemptBase(),
        rawResponse: response.text,
        rawProviderPayload: response.raw,
        parsed: null,
        error: {
          name: err instanceof Error ? err.name : "Error",
          message: err instanceof Error ? err.message : String(err),
          category: err instanceof LlmResponseParseError ? (err.category ?? undefined) : undefined,
        },
        accepted: false,
        rejectionReason: "parse_error" satisfies AttemptRejectionReason,
        willRetry: false,
      });
      throw err;
    }

    lastDuplicateResult = checkDuplicatePost({
      candidateText: lastParsed.text,
      recentPosts,
    });
    lastSemanticResult = semanticGate
      ? await semanticGate({
          coreMessage: lastParsed.coreMessage,
          topic: lastParsed.topic,
          aspectFocus: currentAspect?.focus,
        })
      : NO_SEMANTIC_GATE;
    lastCoreMessageGeneric = assessCoreMessage(lastParsed.coreMessage).generic;
    // Topic Memory: reject a candidate whose normalized topic was already used.
    lastTopicRepeated = isTopicRepeated(lastParsed.topic, diversityOptions?.recentTopics ?? []);
    // Post-generation compliance gate: is the text free of banned terms? The
    // angle/hook/structure/CTA it was generated under are NOT re-verified here —
    // they are generation guidance and never a gate (see generation-compliance.ts).
    lastComplianceResult = validateGenerationCompliance({ text: lastParsed.text });

    // Diagnostic compliance logging. `enforced` names the dimensions that can
    // actually block; everything absent from it (angle/hook/structure/CTA) is
    // prompt guidance that is never verified after generation, so it can never
    // appear as a failure here.
    if (lastComplianceResult.evaluated) {
      const enforcedDimensions = (
        Object.entries(lastComplianceResult.checked) as Array<[ComplianceDimension, boolean]>
      )
        .filter(([, isEnforced]) => isEnforced)
        .map(([dim]) => dim)
        .join(",");
      const failedDimensions =
        lastComplianceResult.failures.length > 0
          ? lastComplianceResult.failures.map((f) => f.dimension).join(",")
          : "none";
      console.info(
        `[generation-compliance] attempt=${attempt} enforced=${enforcedDimensions || "none"} failed=${failedDimensions} (stylistic dimensions are guidance only)`
      );
      if (lastComplianceResult.failures.length > 0) {
        lastComplianceResult.failures.forEach((failure) => {
          console.info(`  ${failure.dimension}: ${failure.reason}`);
        });
      }
    }

    // Retry on a near-verbatim (Jaccard) hit, a semantic-duplicate "regenerate",
    // a generic coreMessage (broad praise hides real repetition), a repeated
    // conceptual topic, OR a failed compliance check. The loop itself never
    // throws: the last candidate is returned with every verdict attached, and
    // the caller decides which verdicts are fatal (the generation service
    // aborts on an unresolved duplicate and on unresolved noncompliance).
    const needsRetry =
      lastDuplicateResult.flagged ||
      lastSemanticResult.decision === "regenerate" ||
      lastCoreMessageGeneric ||
      lastTopicRepeated ||
      lastComplianceResult.status === "failed";

    // Diagnostic: which of the triggers fired, and whether retries remain.
    const rejectionReason: AttemptRejectionReason | null = !needsRetry
      ? null
      : lastDuplicateResult.flagged
        ? "jaccard_duplicate"
        : lastSemanticResult.decision === "regenerate"
          ? "semantic_duplicate"
          : lastCoreMessageGeneric
            ? "generic_core_message"
            : lastTopicRepeated
              ? "repeated_topic"
              : "compliance_failed";
    lastRejectionReason = rejectionReason;
    const willRetry = needsRetry && attempt < maxAttempts;

    if (needsRetry) {
      console.info(
        `[llm-diag] attempt ${attempt} needs retry: reason=${rejectionReason} willRetry=${willRetry}${
          willRetry ? "" : " (retries exhausted — returning last candidate)"
        }`
      );
    } else {
      console.info(`[llm-diag] attempt ${attempt} accepted`);
    }

    report({
      ...attemptBase(),
      rawResponse: response.text,
      rawProviderPayload: response.raw,
      parsed: lastParsed,
      duplicate: lastDuplicateResult,
      semantic: lastSemanticResult,
      coreMessageGeneric: lastCoreMessageGeneric,
      topicRepeated: lastTopicRepeated,
      compliance: lastComplianceResult,
      accepted: !needsRetry,
      rejectionReason,
      willRetry,
    });

    if (!needsRetry) break;
  }

  // lastParsed is non-null: the loop always executes at least once.
  return {
    parsed: lastParsed!,
    duplicateResult: lastDuplicateResult,
    semanticResult: lastSemanticResult,
    coreMessageGeneric: lastCoreMessageGeneric,
    topicRepeated: lastTopicRepeated,
    complianceResult: lastComplianceResult,
    attempts: attemptsMade,
    selectedAngle: currentAngle,
    selectedPattern: currentPattern,
    selectedAspect: currentAspect,
  };
}
