import type { ILlmProvider } from "./types";
import { parseLlmPost, type ParsedLlmPost } from "./parse-llm-post";
import { LlmResponseParseError } from "./errors";
import { type DuplicateCheckResult, type RecentPost } from "./quality/duplicate-detection";
import { extractOpeningSignature, type OpeningDiversityResult } from "./quality/opening-diversity";
import { type ComplianceResult } from "./quality/generation-compliance";
import {
  evaluateCandidate,
  NO_COMPLIANCE_CHECK,
  NO_DUPLICATE_CHECK,
  NO_OPENING_CHECK,
  NO_SEMANTIC_GATE,
  type DuplicateCandidateContext,
  type SemanticGate,
  type SemanticGateResult,
} from "./quality/evaluate-candidate";
import { buildRetryUserPrompt } from "./prompt-builder";
import { type ContentAngle, selectRetryAngle } from "./content-angle";
import { type PostPattern, selectRetryPattern } from "./post-pattern";
import { type ContentAspect, selectRetryAspect } from "./content-aspect";
import type {
  AttemptRejectionReason,
  GenerationAttemptRecorder,
} from "@/lib/generation-trace/attempt-record";
import type { MultiAgentProvenance } from "./crew/provenance";

export const MAX_GENERATION_ATTEMPTS = 3;

/**
 * The gate types and the gate evaluator now live in `quality/evaluate-candidate.ts`
 * so the multi-agent strategy judges its candidates with the SAME implementation
 * rather than a copy (see that module's docblock). They are re-exported here
 * because this module has always been where callers import them from, and moving
 * an import path is churn with no benefit.
 */
export type { DuplicateCandidateContext, SemanticGate, SemanticGateResult };

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
  /**
   * Realised-opening diversity of the accepted (or last) candidate: did its
   * actual first line repeat a recent post's first line?
   *
   * A retry trigger here, and nothing more — this loop never aborts on it,
   * whatever `matchType` says. The CALLER decides what survives exhaustion:
   * `generate-draft-post.service.ts` persists a `repeated_form` or
   * `saturated_form` miss (a contextual, stylistic read that must not be able
   * to destroy usable content) but refuses to save a `near_exact` one — the
   * same textual evidence Jaccard already treats as a hard duplicate, just
   * measured over the opening. See quality/opening-diversity.ts.
   */
  openingResult: OpeningDiversityResult;
  /** Number of generation attempts actually made (1..maxAttempts). */
  attempts: number;
  /** The content angle that produced the accepted (or last) result. */
  selectedAngle?: ContentAngle;
  /** The writing pattern that produced the accepted (or last) result. */
  selectedPattern?: PostPattern;
  /** The content aspect that produced the accepted (or last) result. */
  selectedAspect?: ContentAspect;
  /**
   * How this candidate was produced, when it was NOT the single-agent loop.
   *
   * Every field is optional so `generateWithRetry` leaves the whole object
   * undefined and the type stays exactly as compatible as it was — that
   * compatibility is what lets `bindMultiAgent` be a drop-in for
   * `deps.generateWithRetry`. See `lib/ai/crew/provenance.ts` for the shape and
   * for why the application provider label alone cannot establish A/B model
   * equality.
   */
  multiAgent?: MultiAgentProvenance;
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
  recorder?: GenerationAttemptRecorder,
  /** Identifies THIS generation for `[jaccard_duplicate]` diagnostics only. */
  candidateContext?: DuplicateCandidateContext,
  /**
   * The language the post was required to be in ("BG" / "EN"). Enables the
   * compliance gate's language dimension; omitted, that dimension is reported as
   * unchecked rather than as a pass.
   */
  contentLanguage?: string | null
): Promise<GenerationLoopResult> {
  let lastParsed: ParsedLlmPost | null = null;
  let lastDuplicateResult: DuplicateCheckResult = NO_DUPLICATE_CHECK;
  let lastSemanticResult: SemanticGateResult = NO_SEMANTIC_GATE;
  let lastCoreMessageGeneric = false;
  let lastTopicRepeated = false;
  let lastComplianceResult: ComplianceResult = NO_COMPLIANCE_CHECK;
  let lastOpeningResult: OpeningDiversityResult = NO_OPENING_CHECK;
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

      // When the previous attempt's opening repeated recent output, hand back
      // the repeated shape — and ONLY the shape. A short signature of the
      // colliding opening is enough for the model to steer away from it; the
      // historical posts themselves stay out of the prompt.
      const repeatedOpening = lastOpeningResult.flagged
        ? {
            matchType: lastOpeningResult.matchType!,
            candidateForm: lastOpeningResult.candidateForm,
            candidateOpening: extractOpeningSignature(lastParsed.text).excerpt,
            matchedOpening: lastOpeningResult.matchedOpening,
          }
        : undefined;

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
        repeatedOpening,
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

    // Every deterministic gate, in one shared implementation — the same one the
    // multi-agent strategy judges its candidates with. The loop itself never
    // throws: the last candidate is returned with every verdict attached, and
    // the caller decides which verdicts are fatal (the generation service aborts
    // on an unresolved duplicate and on unresolved noncompliance — never on a
    // repeated opening).
    const verdict = await evaluateCandidate({
      parsed: lastParsed,
      recentPosts,
      semanticGate,
      recentTopics: diversityOptions?.recentTopics,
      contentLanguage,
      aspectFocus: currentAspect?.focus,
      attempt,
      candidateContext,
    });

    lastDuplicateResult = verdict.duplicateResult;
    lastSemanticResult = verdict.semanticResult;
    lastCoreMessageGeneric = verdict.coreMessageGeneric;
    lastTopicRepeated = verdict.topicRepeated;
    lastComplianceResult = verdict.complianceResult;
    lastOpeningResult = verdict.openingResult;

    const needsRetry = verdict.needsRetry;
    // Diagnostic: which of the triggers fired, and whether retries remain.
    const rejectionReason: AttemptRejectionReason | null = verdict.rejectionReason;
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
      openingDiversity: lastOpeningResult,
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
    openingResult: lastOpeningResult,
    attempts: attemptsMade,
    selectedAngle: currentAngle,
    selectedPattern: currentPattern,
    selectedAspect: currentAspect,
  };
}
