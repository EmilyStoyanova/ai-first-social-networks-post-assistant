/**
 * Truthful provenance for a generation, and the fingerprint an A/B comparison
 * has to rest on.
 *
 * ── Why the provider label is not enough ────────────────────────────────────
 *
 * An orchestration experiment must vary only ORCHESTRATION. Both arms of the
 * multi-agent experiment reach the same local Qwen, but by different
 * application paths: the control arm goes `text_worker` → Ollama, the
 * multi-agent arm goes CrewAI sidecar → Ollama. So `Post.llmProvider` will and
 * SHOULD differ between the arms — it is honest provenance about the path, and
 * it is preserved unchanged on both. What it cannot do is establish that the
 * two arms ran the same model, because it describes the caller, not the
 * inference.
 *
 * There is a concrete, live reason not to trust the label. Generation builds
 * `{ temperature: 0.85, maxTokens: 1024 }`, but `TextWorkerProvider.generate`
 * forwards those into Ollama's `options` only when `request.format` is set —
 * and generation never sets `format`; only translation does. So on the
 * text-worker path the control arm is NOT running at 0.85: Ollama falls back to
 * the tag's Modelfile defaults. CrewAI/litellm, meanwhile, does send explicit
 * sampling parameters. Left alone the two arms would differ on temperature
 * while reporting identical providers and identical model names.
 *
 * Equality is therefore asserted one layer down, on what Ollama actually ran:
 * the exact tag, its digest, and the sampling parameters. `inferenceFingerprint`
 * is a SHA-256 over the canonical JSON of exactly those fields, and a report
 * compares fingerprints rather than labels.
 */

import { createHash } from "node:crypto";

/** Which strategy produced a post. */
export type GenerationStrategy = "single" | "multi";

/**
 * Why that strategy was chosen. Kept distinct from the strategy itself because
 * "multi because an experiment assigned it" and "multi because a user asked for
 * it" are different populations: only the first may enter an A/B denominator,
 * and the second is confounded by self-selection.
 */
export type StrategySource = "global_default" | "user_override" | "ab_split";

/**
 * The sampling parameters as ACTUALLY sent to Ollama — not as the application
 * intended them.
 *
 * Every field is optional and only present when it was really sent, because an
 * absent parameter and a parameter set to the model's default are different
 * facts: the first means "Ollama used its Modelfile value", the second means
 * "we pinned it". Recording a default we did not send would make the
 * fingerprint claim an equality that does not hold.
 */
export interface InferenceSettings {
  temperature?: number;
  topP?: number;
  topK?: number;
  seed?: number;
  numCtx?: number;
  numPredict?: number;
  repeatPenalty?: number;
  stop?: readonly string[];
  /**
   * Whether the model's reasoning preamble is enabled.
   *
   * Unlike the sampling parameters above, this one the control arm ALREADY
   * pins: `TextWorkerProvider` → Ollama `/api/generate` sends `think: false` on
   * every call, unconditionally. So recording `think: false` is truthful about
   * that runtime, and as of 2026-09-10 EVERY multi run pins it too — the
   * sidecar reaches Ollama's `/v1` where `reasoning_effort: "none"` is the
   * field that actually disables the preamble (see `experiment-inference.ts`
   * and the sidecar's `inference_config.py`). Absent means "not pinned — the
   * model's default applies", which is every non-experiment SINGLE-agent run.
   */
  think?: boolean;
}

/** What Ollama ran, as opposed to which application path asked it to. */
export interface InferenceProfile {
  /** The exact Ollama tag, e.g. `qwen3.5:35b-a3b-q4_K_M`. */
  modelTag: string;
  /**
   * The model's content digest, when the installed Ollama exposes one. Null is a
   * legitimate value and is reported as such: a comparison over a null digest is
   * labelled `tag-matched only`, never silently promoted to `digest-verified`.
   */
  modelDigest: string | null;
  settings: InferenceSettings;
}

/**
 * `sha256` over the canonical JSON of an inference profile.
 *
 * Canonical means: keys sorted, undefined dropped, no whitespace. Sorting is
 * what makes the fingerprint independent of the order two different code paths
 * happened to build their objects in — without it, two identical profiles would
 * fingerprint differently and the report would refuse a valid comparison.
 */
export function inferenceFingerprint(profile: InferenceProfile): string {
  const canonical = canonicalize({
    modelTag: profile.modelTag,
    modelDigest: profile.modelDigest,
    settings: profile.settings as unknown as Record<string, unknown>,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Whether two arms may be compared, and on what evidence.
 *
 * `refused` is deliberately not a warning: a comparison across differing
 * inference settings measures the model, not the orchestration, and rendering
 * it with a footnote invites exactly the conclusion the experiment cannot
 * support.
 */
export type ComparabilityVerdict =
  | { comparable: true; basis: "digest-verified" }
  | { comparable: true; basis: "tag-matched only" }
  | { comparable: false; reason: string };

export function compareInference(a: InferenceProfile, b: InferenceProfile): ComparabilityVerdict {
  if (inferenceFingerprint(a) !== inferenceFingerprint(b)) {
    if (a.modelTag !== b.modelTag) {
      return {
        comparable: false,
        reason: `Model tags differ: ${a.modelTag} vs ${b.modelTag}.`,
      };
    }
    if (a.modelDigest !== b.modelDigest) {
      return {
        comparable: false,
        reason: `Model digests differ for tag ${a.modelTag}.`,
      };
    }
    return {
      comparable: false,
      reason: `Sampling settings differ for tag ${a.modelTag}.`,
    };
  }
  return a.modelDigest === null
    ? { comparable: true, basis: "tag-matched only" }
    : { comparable: true, basis: "digest-verified" };
}

/**
 * Everything a multi-agent run knows about itself, recorded on the loop result.
 *
 * Counters are per OUTER attempt totals across the whole run, so a run that
 * spent two outer attempts reports the sum — which is what a cost question
 * asks. `qaRevisionRounds` is the maximum reached in any single attempt, since
 * the bound (`maxQaRounds`) is per attempt.
 */
export interface MultiAgentProvenance {
  strategy: GenerationStrategy;
  strategySource: StrategySource;
  inference: InferenceProfile;
  /** Derived from `inference`; stored so a report need not recompute it. */
  inferenceFingerprint: string;
  writerCalls: number;
  editorCalls: number;
  qaCalls: number;
  /** Highest revision-cycle count reached in any single outer attempt. */
  qaRevisionRounds: number;
  /** Total agent calls — the cost figure. */
  agentCalls: number;
  /** Wall-clock ms across every sidecar call this run made. */
  latencyMs: number;
  /**
   * True when a usable candidate exists but a stage did not complete — an
   * Editor that failed, or a QA that could not run. Never true for a clean run,
   * and never used to mean "QA passed".
   */
  degraded: boolean;
  /** Which stages degraded, named. Empty when `degraded` is false. */
  degradedStages: readonly string[];
  /** The final QA state of the accepted (or last) candidate. */
  qaState: QaState;
}

/**
 * The objective, non-outcome measurements from the outer attempts that DID
 * complete before a multi-agent run threw its terminal error.
 *
 * Carried on `MultiAgentGenerationError` so the generation service can persist
 * "what the provider actually did and cost" onto a FAILED `GenerationRun` —
 * which is exactly the run an A/B failure-rate analysis is made of, and which
 * would otherwise carry only NULLs because the throw skips the normal
 * measurement write.
 *
 * Deliberately excludes `qaState` and `qaRevisionRounds`: those describe a
 * run-level QA outcome, and a run that saved no post reached none. The last
 * completed attempt's QA verdict stays where it is correctly scoped — the
 * per-attempt `generation_steps` provider payload.
 */
export interface MultiAgentPartialProvenance {
  /** The pinned profile — its tag/digest/settings are known before any call. */
  inference: InferenceProfile;
  /** `inferenceFingerprint(inference)`, precomputed. */
  inferenceFingerprint: string;
  /** Summed agent calls across the attempts that returned. Never estimated. */
  agentCalls: number;
  /** Summed wall-clock ms across the attempts that returned. Never estimated. */
  agentLatencyMs: number;
  /** Always true: a run that failed mid-way is degraded by definition. */
  degraded: true;
  /** Named stages, plus the terminal failure stage (`provider_error` / `budget_exhausted`). */
  degradedStages: string[];
  /** How many outer attempts produced a provider response before the failure. */
  completedAttempts: number;
}

/**
 * The five QA states, and the whole reason the taxonomy is not three.
 *
 * The asymmetry between `rejected_unroutable` and `unavailable` is deliberate.
 * A critic that RAN AND SAID NO is information, and the deterministic gates
 * passing does not erase it — so a candidate in that state is never acceptable,
 * however clean its gates. A critic that COULD NOT RUN said nothing at all, and
 * the deterministic gates are then the whole verdict — so that candidate may be
 * saved, marked degraded, and is never recorded as having passed QA.
 */
export type QaState =
  /** QA ran; no failing dimension. */
  | "pass"
  /** Failing dimension is factual/content — Writer revises, THEN Editor, then QA. */
  | "revise_writer"
  /** Failing dimension is style/clarity — Editor revises, then QA. */
  | "revise_editor"
  /**
   * QA ran and parsed, rejected the candidate, but named no dimension the
   * router can act on. A non-converged attempt: it ends the inner loop and
   * consumes an OUTER attempt. Never acceptable.
   */
  | "rejected_unroutable"
  /**
   * QA could not run: timeout, unparseable reply, model error. Degraded, never
   * a pass — this is the state requirement 7 exists to name.
   */
  | "unavailable";

/**
 * The acceptance rule, in one place.
 *
 * `accept ⇔ gates say no retry AND qaState ∈ { pass, unavailable }`
 *
 * Both conditions are necessary, and neither overrides the other: the gates
 * never override QA, and QA never overrides the gates.
 */
export function isAcceptableQaState(state: QaState): boolean {
  return state === "pass" || state === "unavailable";
}
