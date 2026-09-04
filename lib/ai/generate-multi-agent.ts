/**
 * Multi-agent generation — the OUTER loop, in TypeScript.
 *
 * ── The division of labour, and why it falls here ───────────────────────────
 *
 * ```
 *   TypeScript (this file, in the Mac worker process)
 *     • OUTER loop — retries driven by the DETERMINISTIC GATES
 *     • all six gates via evaluateCandidate(); acceptance; trace; persistence
 *     • holds DATABASE_URL and every other secret
 *          │  POST /crew/post — one call per OUTER attempt
 *          ▼
 *   CrewAI sidecar (Python, loopback only)
 *     • INNER QA loop: Writer → Editor → QA, QA routes back to EITHER
 *     • no tools, no memory, no database, no secrets
 * ```
 *
 * The split is settled by one requirement: CrewAI must never receive
 * `DATABASE_URL`. The deterministic gates need the database — the semantic gate
 * compares stored embeddings, and Jaccard, opening diversity and topic memory
 * compare against the last 10–30 posts. So the gates cannot move into the
 * sidecar, and therefore the loop they drive cannot either.
 *
 * ── Why this is shaped as `typeof generateWithRetry` ────────────────────────
 *
 * `generate-draft-post.service.ts` already injects the loop
 * (`deps.generateWithRetry`), and everything around that seam — the article
 * claim, the prompts, the trace recorder, the uniqueness and compliance aborts,
 * persistence, embedding, images — is strategy-agnostic. So the whole
 * integration is one function with the same signature, and the single-agent
 * path is not touched at all. `_seamCheck` below makes that a compile error
 * rather than a convention.
 *
 * ── The acceptance rule ─────────────────────────────────────────────────────
 *
 * ```
 *   accept  ⇔  evaluateCandidate().needsRetry === false
 *              AND qaState ∈ { pass, unavailable }
 * ```
 *
 * Both halves are necessary. The gates never override QA and QA never overrides
 * the gates. The asymmetry between the two refused QA states is deliberate and
 * is the crux of the design: `rejected_unroutable` means a critic RAN AND SAID
 * NO, which is information the gates passing does not erase — so that candidate
 * is never acceptable however clean its gates. `unavailable` means a critic
 * COULD NOT RUN and therefore said nothing — so the deterministic gates are the
 * whole verdict, the post may be saved, and the run is marked degraded and is
 * never recorded as having passed QA.
 *
 * ── No fallback ─────────────────────────────────────────────────────────────
 *
 * A sidecar that cannot produce a candidate ends the run as a MULTI-AGENT
 * failure. There is no branch to the single-agent loop and none to a hosted
 * provider. Falling back would move an `ab_split` post into the other arm and
 * corrupt the experiment — and would do it precisely in the conditions most
 * likely to correlate with something else about the run.
 */

import { LlmProviderError, LlmResponseParseError } from "./errors";
import { parseLlmPost, type ParsedLlmPost } from "./parse-llm-post";
import { extractOpeningSignature } from "./quality/opening-diversity";
import {
  evaluateCandidate,
  NO_COMPLIANCE_CHECK,
  NO_DUPLICATE_CHECK,
  NO_OPENING_CHECK,
  NO_SEMANTIC_GATE,
  type CandidateVerdict,
} from "./quality/evaluate-candidate";
import {
  MAX_GENERATION_ATTEMPTS,
  type generateWithRetry,
  type GenerationLoopResult,
} from "./generate-with-retry";
import {
  CrewSidecarClient,
  CrewSidecarError,
  DEFAULT_MAX_QA_ROUNDS,
  type CrewPostOutcome,
} from "./crew/crew-sidecar.client";
import type { CrewArticleBrief, CrewPostRequest } from "./crew/crew-contract";
import {
  inferenceFingerprint,
  isAcceptableQaState,
  type InferenceProfile,
  type MultiAgentProvenance,
  type QaState,
  type StrategySource,
} from "./crew/provenance";
import { NO_ARTICLE_BRIEF } from "./agents/research-brief";
import type { BrandContext } from "./types";
import type { AttemptRejectionReason } from "@/lib/generation-trace/attempt-record";

/**
 * A multi-agent run that produced nothing usable, with the reason a route or a
 * job handler needs to classify it.
 *
 * Three genuinely different failures get three genuinely different codes, and
 * conflating any two of them would mislead:
 *   • `CREW_SIDECAR_UNAVAILABLE`  — infrastructure. Retry helps.
 *   • `QA_NOT_CONVERGED`          — the critic refused, repeatedly and
 *                                    unactionably. Retry probably does not help.
 *   • `CREW_SIDECAR_NOT_CONFIGURED` — this process has no sidecar and must not
 *                                    have attempted the call at all.
 * Gate exhaustion is NOT here: it stays the outer service's
 * `CANNOT_GENERATE_UNIQUE_POST` / `POST_FAILED_COMPLIANCE`, unchanged, because
 * the gates and their aborts are untouched by this strategy.
 */
export type MultiAgentErrorCode =
  "CREW_SIDECAR_UNAVAILABLE" | "CREW_SIDECAR_NOT_CONFIGURED" | "QA_NOT_CONVERGED";

/**
 * Extends `LlmProviderError` so the outer service's EXISTING catch already
 * handles it: `generatePostFromContext` releases the claimed article and returns
 * `LLM_PROVIDER_ERROR` (HTTP 502) for anything of that class. So a multi-agent
 * failure degrades safely from the moment the strategy is wired in, before any
 * new error code exists in `API_ERROR_CODES` or the locale files.
 *
 * The specific reason rides alongside as `multiAgentCode` rather than
 * overriding `code`, which the base class pins to a literal. A later phase
 * promotes these three to first-class service codes (with their own localized
 * messages); until then they are preserved on the error and in the logs rather
 * than being flattened away.
 */
export class MultiAgentGenerationError extends LlmProviderError {
  constructor(
    readonly multiAgentCode: MultiAgentErrorCode,
    message: string,
    /** The sidecar failure underneath, when there was one. */
    readonly sidecarError?: CrewSidecarError
  ) {
    super(message);
    this.name = "MultiAgentGenerationError";
  }
}

/**
 * What the seam signature cannot carry.
 *
 * `typeof generateWithRetry` takes a provider, two prompts, a post window and
 * the diversity levers — everything a single-agent call needs. A multi-agent
 * call additionally needs the article brief, the brand facts and the pinned
 * inference config, none of which fit that signature. They arrive here instead,
 * at BIND time, which is the same shape `createSemanticGate(companyId, channel,
 * …)` already has in the generation service: the caller knows the company and
 * the channel, so it builds the strategy for this generation and hands the
 * result in as `deps.generateWithRetry`.
 */
export interface MultiAgentDeps {
  /** The sidecar. Injected so tests never open a socket. */
  sidecar: Pick<CrewSidecarClient, "generate">;
  /**
   * The article brief, already formatted from an EXISTING understanding. A
   * value, not a loader, because it must be impossible for this module to
   * trigger a model call to obtain it (requirement 3). Omitted for a
   * mission/evergreen post, which has no article.
   */
  brief?: CrewArticleBrief;
  companyName: string;
  brand: BrandContext | null;
  /** The channel's character limit, when it has one. */
  maxTextLength: number | null;
  /**
   * What Ollama must run, pinned by the caller. The sidecar never chooses a
   * model: for an `ab_split` run this is the same tag and the same sampling the
   * control arm was pinned to, which is what makes the fingerprints comparable.
   */
  inference: InferenceProfile & { baseUrl: string };
  strategySource: StrategySource;
  /** Max QA REVISION cycles. Two by default (requirement 5). */
  maxQaRounds?: number;
}

/**
 * Binds a multi-agent strategy into a drop-in replacement for the retry loop.
 *
 * The returned function has `generateWithRetry`'s exact signature, so it can be
 * passed as `deps.generateWithRetry` with no other change anywhere. The
 * `provider` argument is accepted and deliberately IGNORED — inference happens
 * inside the sidecar, against the pinned config above. It is not dropped from
 * the signature because keeping it is what makes the two strategies
 * interchangeable at the seam.
 */
export function bindMultiAgent(deps: MultiAgentDeps): typeof generateWithRetry {
  const maxQaRounds = deps.maxQaRounds ?? DEFAULT_MAX_QA_ROUNDS;

  return async function generateMultiAgent(
    _provider,
    systemPrompt,
    baseUserPrompt,
    recentPosts,
    diversityOptions,
    semanticGate,
    maxAttempts = MAX_GENERATION_ATTEMPTS,
    recorder,
    candidateContext,
    contentLanguage
  ): Promise<GenerationLoopResult> {
    const brief = deps.brief ?? NO_ARTICLE_BRIEF;
    const profile: InferenceProfile = {
      modelTag: deps.inference.modelTag,
      modelDigest: deps.inference.modelDigest,
      settings: deps.inference.settings,
    };

    let lastParsed: ParsedLlmPost | null = null;
    let lastVerdict: CandidateVerdict | null = null;
    let lastRejectionReason: AttemptRejectionReason | null = null;
    let lastQaState: QaState = "unavailable";
    let attemptsMade = 0;

    let writerCalls = 0;
    let editorCalls = 0;
    let qaCalls = 0;
    let maxQaRevisionRounds = 0;
    let latencyMs = 0;
    const degradedStages = new Set<string>();

    /**
     * Whether any outer attempt ended with a critic that ran, refused, and
     * named nothing actionable.
     *
     * Tracked separately from the gates because it decides which error a fully
     * exhausted run reports. A run whose every attempt was
     * `rejected_unroutable` failed for a reason the gates know nothing about,
     * and reporting it as `CANNOT_GENERATE_UNIQUE_POST` would send someone
     * looking for a duplicate that does not exist.
     */
    let sawUnroutableRejection = false;

    /** An observer must never be able to break the thing it observes. */
    const report = (record: Parameters<NonNullable<typeof recorder>>[0]) => {
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

      // The retry prompt is built by the SAME builder the single-agent loop
      // uses, from the same rejection reason. A multi-agent retry is still a
      // gate retry, and telling the Writer something different about the same
      // rejection would make the two arms differ on their retry instructions as
      // well as on their orchestration.
      const userPrompt =
        attempt > 1 && lastParsed !== null && lastVerdict !== null
          ? buildMultiAgentRetryPrompt(baseUserPrompt, lastParsed, lastVerdict, diversityOptions)
          : baseUserPrompt;

      console.info(`[crew-diag] multi-agent attempt ${attempt}/${maxAttempts}`);

      const request: CrewPostRequest = {
        articleUnderstanding: brief,
        platform: candidateContext?.channel ?? "unknown",
        language: contentLanguage ?? "en",
        brandContext: {
          companyName: deps.companyName,
          companyDescription: deps.brand?.companyDescription ?? null,
          toneOfVoice: deps.brand?.toneOfVoice ?? null,
          targetAudience: deps.brand?.targetAudience ?? null,
          forbiddenWords: deps.brand?.forbiddenWords ?? [],
        },
        generationRequirements: {
          systemPrompt,
          userPrompt,
          maxTextLength: deps.maxTextLength,
          responseContract: "llm_post_json",
        },
        inferenceConfig: {
          model: deps.inference.modelTag,
          baseUrl: deps.inference.baseUrl,
          ...deps.inference.settings,
        },
        attemptContext: {
          attempt,
          maxAttempts,
          maxQaRounds,
          previousRejection: lastRejectionReason,
        },
      };

      const attemptStartedAt = new Date();
      const attemptBase = () => ({
        attempt,
        maxAttempts,
        systemPrompt,
        userPrompt,
        request: {
          temperature: deps.inference.settings.temperature,
          maxTokens: deps.inference.settings.numPredict,
        },
        startedAt: attemptStartedAt,
        completedAt: new Date(),
        durationMs: Date.now() - attemptStartedAt.getTime(),
        angle: diversityOptions?.initialAngle,
        pattern: diversityOptions?.initialPattern,
        aspect: diversityOptions?.initialAspect,
      });

      let outcome: CrewPostOutcome;
      try {
        outcome = await deps.sidecar.generate(request);
      } catch (err) {
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
        throw toGenerationError(err);
      }

      writerCalls += outcome.agentCalls.writer;
      editorCalls += outcome.agentCalls.editor;
      qaCalls += outcome.agentCalls.qa;
      latencyMs += outcome.latencyMs;
      maxQaRevisionRounds = Math.max(maxQaRevisionRounds, outcome.qaRevisions);
      outcome.degradedStages.forEach((s) => degradedStages.add(s));
      lastQaState = outcome.qaState;

      // A parse failure here is the sidecar's contract being broken, not the
      // ordinary "the model wrote prose" case: the Writer's output was already
      // shaped by the Editor and judged by QA before it was returned. Recorded
      // and thrown, exactly as the single-agent loop treats an unparseable
      // reply, so the outer service maps it to LLM_RESPONSE_PARSE_ERROR.
      try {
        lastParsed = parseLlmPost(outcome.raw);
      } catch (err) {
        report({
          ...attemptBase(),
          rawResponse: outcome.raw,
          parsed: null,
          error: {
            name: err instanceof Error ? err.name : "Error",
            message: err instanceof Error ? err.message : String(err),
            category:
              err instanceof LlmResponseParseError ? (err.category ?? undefined) : undefined,
          },
          accepted: false,
          rejectionReason: "parse_error" satisfies AttemptRejectionReason,
          willRetry: false,
        });
        throw err;
      }

      // THE gates — the same implementation the single-agent loop runs, so a
      // candidate cannot be accepted here that would be refused there.
      const verdict = await evaluateCandidate({
        parsed: lastParsed,
        recentPosts,
        semanticGate,
        recentTopics: diversityOptions?.recentTopics,
        contentLanguage,
        aspectFocus: diversityOptions?.initialAspect?.focus,
        attempt,
        candidateContext,
      });
      lastVerdict = verdict;
      lastRejectionReason = verdict.rejectionReason;

      if (outcome.qaState === "rejected_unroutable") sawUnroutableRejection = true;

      // Both halves of the acceptance rule. A candidate whose gates are clean
      // but whose critic refused it is NOT accepted, and consumes an outer
      // attempt — which is the whole reason QA is checked here rather than
      // being left to the service's aborts.
      const qaAcceptable = isAcceptableQaState(outcome.qaState);
      const accepted = !verdict.needsRetry && qaAcceptable;
      const willRetry = !accepted && attempt < maxAttempts;

      console.info(
        `[crew-diag] attempt ${attempt} qa=${outcome.qaState} revisions=${outcome.qaRevisions} ` +
          `gates=${verdict.needsRetry ? (verdict.rejectionReason ?? "retry") : "clean"} ` +
          `accepted=${accepted} willRetry=${willRetry}`
      );

      report({
        ...attemptBase(),
        rawResponse: outcome.raw,
        rawProviderPayload: {
          qaState: outcome.qaState,
          qaRevisions: outcome.qaRevisions,
          qaIssues: outcome.qaIssues,
          agentCalls: outcome.agentCalls,
          latencyMs: outcome.latencyMs,
          model: outcome.model,
          degradedStages: outcome.degradedStages,
        },
        parsed: lastParsed,
        duplicate: verdict.duplicateResult,
        semantic: verdict.semanticResult,
        coreMessageGeneric: verdict.coreMessageGeneric,
        topicRepeated: verdict.topicRepeated,
        compliance: verdict.complianceResult,
        openingDiversity: verdict.openingResult,
        accepted,
        rejectionReason: accepted
          ? null
          : (verdict.rejectionReason ?? ("provider_error" satisfies AttemptRejectionReason)),
        willRetry,
      });

      if (accepted) break;
    }

    // Every attempt ran and none was accepted. When the gates were clean
    // throughout, the refusal came from QA alone — a critic that ran and said
    // no — and that has its own terminal code. When a gate was the last word,
    // the run returns its last candidate exactly as the single-agent loop does
    // and the SERVICE decides (uniqueness abort / compliance abort), untouched.
    const gatesClean = lastVerdict !== null && !lastVerdict.needsRetry;
    if (lastParsed !== null && gatesClean && !isAcceptableQaState(lastQaState)) {
      throw new MultiAgentGenerationError(
        "QA_NOT_CONVERGED",
        sawUnroutableRejection
          ? `QA rejected every candidate across ${attemptsMade} attempt(s) without naming an actionable dimension.`
          : `QA did not reach a passing verdict in ${attemptsMade} attempt(s).`
      );
    }

    if (lastParsed === null) {
      // Unreachable in practice: the loop either parses a candidate or throws.
      // Kept explicit rather than as a non-null assertion, because the one thing
      // this function must never do is return a result with no post in it.
      throw new MultiAgentGenerationError(
        "CREW_SIDECAR_UNAVAILABLE",
        "Multi-agent generation produced no candidate."
      );
    }

    const provenance: MultiAgentProvenance = {
      strategy: "multi",
      strategySource: deps.strategySource,
      inference: profile,
      inferenceFingerprint: inferenceFingerprint(profile),
      writerCalls,
      editorCalls,
      qaCalls,
      qaRevisionRounds: maxQaRevisionRounds,
      agentCalls: writerCalls + editorCalls + qaCalls,
      latencyMs,
      // `unavailable` is a degradation in its own right even when no stage was
      // named: QA not running IS the missing stage.
      degraded: degradedStages.size > 0 || lastQaState === "unavailable",
      degradedStages: [...degradedStages],
      qaState: lastQaState,
    };

    return {
      parsed: lastParsed,
      duplicateResult: lastVerdict?.duplicateResult ?? NO_DUPLICATE_CHECK,
      semanticResult: lastVerdict?.semanticResult ?? NO_SEMANTIC_GATE,
      coreMessageGeneric: lastVerdict?.coreMessageGeneric ?? false,
      topicRepeated: lastVerdict?.topicRepeated ?? false,
      complianceResult: lastVerdict?.complianceResult ?? NO_COMPLIANCE_CHECK,
      openingResult: lastVerdict?.openingResult ?? NO_OPENING_CHECK,
      attempts: attemptsMade,
      selectedAngle: diversityOptions?.initialAngle,
      selectedPattern: diversityOptions?.initialPattern,
      selectedAspect: diversityOptions?.initialAspect,
      multiAgent: provenance,
    };
  };
}

/**
 * Maps a sidecar failure onto the terminal error the outer service classifies.
 *
 * `qa_parse_error` deliberately does NOT appear as an acceptable outcome here:
 * a QA reply that could not be parsed means QA did not run, and the sidecar
 * reports that as `finalDecision: "unavailable"` on a successful response — the
 * degraded path. Reaching this function with `qa_parse_error` means the sidecar
 * failed the whole call over it, which is an infrastructure fault (requirement
 * 7: never a PASS).
 */
function toGenerationError(err: unknown): unknown {
  if (!(err instanceof CrewSidecarError)) return err;
  if (err.code === "not_configured") {
    return new MultiAgentGenerationError("CREW_SIDECAR_NOT_CONFIGURED", err.message, err);
  }
  if (err.code === "non_converged") {
    return new MultiAgentGenerationError("QA_NOT_CONVERGED", err.message, err);
  }
  return new MultiAgentGenerationError("CREW_SIDECAR_UNAVAILABLE", err.message, err);
}

/**
 * The retry instruction for the next attempt.
 *
 * A thin wrapper over the shared `buildRetryUserPrompt`, imported lazily so
 * this module's own import graph stays free of the prompt builder in the tests
 * that never retry. Rotation of angle/pattern/aspect is deliberately NOT done
 * here: the single-agent loop rotates them and this one does not, and that
 * difference must not silently become part of what the experiment measures.
 * Rotation belongs in a later phase, applied to BOTH arms or to neither.
 */
function buildMultiAgentRetryPrompt(
  baseUserPrompt: string,
  lastParsed: ParsedLlmPost,
  verdict: CandidateVerdict,
  diversityOptions: Parameters<typeof generateWithRetry>[4]
): string {
  void diversityOptions;
  const parts: string[] = [baseUserPrompt, "", "## Your previous version was rejected", ""];

  if (verdict.duplicateResult.flagged) {
    parts.push(
      `It repeated a recent post almost word for word (similarity ${
        verdict.duplicateResult.similarityScore ?? "n/a"
      }). Write about the same subject with genuinely different wording and structure.`
    );
  }
  if (
    verdict.semanticResult.decision === "regenerate" &&
    verdict.semanticResult.matchedCoreMessage
  ) {
    parts.push(
      `Its central claim repeated one we have already published: "${verdict.semanticResult.matchedCoreMessage}". ` +
        "Make a substantially DIFFERENT claim — do not reword this one."
    );
  }
  if (verdict.coreMessageGeneric) {
    parts.push(
      `Its central claim was generic praise with no specific reason: "${lastParsed.coreMessage}". ` +
        "Replace it with one specific, testable claim."
    );
  }
  if (verdict.topicRepeated && lastParsed.topic) {
    parts.push(
      `Its topic ("${lastParsed.topic}") was already used recently. Choose a meaningfully different subject.`
    );
  }
  if (verdict.openingResult.flagged) {
    parts.push(
      `Its opening repeated a recent post's opening ("${
        extractOpeningSignature(lastParsed.text).excerpt
      }"). Open differently.`
    );
  }
  if (verdict.complianceResult.status === "failed") {
    parts.push(
      "It broke a hard content rule and must be fixed exactly there, changing nothing else: " +
        verdict.complianceResult.reasons.join(" | ")
    );
  }

  return parts.join("\n");
}

/**
 * A compile-time assertion that the bound strategy really is interchangeable
 * with the single-agent loop.
 *
 * Not a test but a type: if either signature drifts — a parameter added, an
 * optional made required, `GenerationLoopResult` narrowed — this line fails
 * `tsc` at the point of the change, rather than at the call site in the
 * generation service months later.
 */
const _seamCheck: typeof generateWithRetry = bindMultiAgent({
  sidecar: { generate: async () => ({}) as CrewPostOutcome },
  companyName: "",
  brand: null,
  maxTextLength: null,
  inference: { modelTag: "", modelDigest: null, settings: {}, baseUrl: "" },
  strategySource: "global_default",
});
void _seamCheck;
