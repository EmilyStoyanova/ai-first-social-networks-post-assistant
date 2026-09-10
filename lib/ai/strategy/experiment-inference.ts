/**
 * What both arms run, and how truthfully we can say so.
 *
 * ── The one thing an orchestration experiment must hold constant ────────────
 *
 * An A/B between `single` and `multi` measures ORCHESTRATION. It is worthless if
 * the arms also differ in the model or its sampling, and the two ways that
 * happens are both easy to walk into:
 *
 *   • different models — the control arm resolves whatever LlmConfig is default
 *     (possibly Claude), while the multi arm can only ever reach the local Qwen
 *     through the sidecar;
 *   • different sampling — the same tag run at different temperatures.
 *
 * The first is handled by PINNING: an `ab_split` run's provider is forced to
 * `text_worker`, so both arms reach the same local Ollama tag. A run that cannot
 * be pinned is not entered into the experiment at all (see the resolver's
 * `pinned_model_unavailable`) rather than compared across models.
 *
 * The second is handled by PINNING NOTHING for SAMPLING, which is the
 * counter-intuitive half and is already written down in
 * `sidecar/crewai/inference_config.py`: `TextWorkerProvider.generate` forwards
 * `temperature`/`maxTokens` into Ollama's `options` only when `request.format`
 * is set, and post generation never sets `format` — only translation does. So
 * the control arm sends no sampling options and inherits the tag's Modelfile
 * defaults. If the sidecar pinned sampling while the control arm pinned none,
 * the arms would differ on temperature while reporting the same model. Sending
 * nothing on BOTH sides is the resolution that requires no change to
 * single-agent behaviour, so `settings` carries no sampling keys.
 *
 * ── The one setting that IS pinned: `think` ────────────────────────────────
 *
 * `think` is not sampling and the symmetry argument above does not apply to it.
 * The control arm already pins it: `TextWorkerProvider` → Ollama `/api/generate`
 * sends `think: false` on EVERY call, unconditionally. The multi arm, reaching
 * Ollama through CrewAI's native `openai_compatible` provider
 * (`/v1/chat/completions`), sends nothing and so inherits the model default,
 * which for a reasoning tag is thinking ON — an unrecorded, effective-inference
 * difference between the arms.
 *
 * So the pinned profile carries `think: false`. On the control side this only
 * makes the provenance state a fact that was already true at runtime; on the
 * multi side the sidecar translates it to the field Ollama's `/v1` endpoint
 * actually honours (`reasoning_effort: "none"` — `think` is silently ignored
 * there; probed against Ollama 0.33.1 + `qwen3.5:35b-a3b-q4_K_M` on
 * 2026-09-09). As of 2026-09-10 this profile is handed to the sidecar for
 * EVERY multi run — `user_override` and `global_default` as well as `ab_split`
 * — after a proxy-attributed benchmark showed the reasoning preamble is the
 * dominant per-call latency on this model with no offsetting quality or
 * call-count cost. The single-agent path is untouched: the text worker already
 * sends `think: false` unconditionally, and a non-experiment single run still
 * records empty `settings`.
 *
 * ── Why the digest is not asserted ──────────────────────────────────────────
 *
 * There is a known audited digest for the validated tag. It is deliberately NOT
 * used here. Knowing what a digest should be is not the same as having observed
 * it, and `digest_verified` is a claim about observation. The sidecar reads
 * Ollama's `/api/show` at run time and reports whatever it finds, including
 * `null`; a null becomes `tag_matched_only`. Hard-coding the audit value would
 * make every run claim a verification nobody performed.
 */

import type { InferenceProfile, StrategySource } from "@/lib/ai/crew/provenance";
import type { ModelVerification } from "@prisma/client";
import { getSupportedProviderInfo } from "@/lib/ai/llm/supported-providers";
import type { LlmProvider } from "@prisma/client";

/**
 * The provider both arms are pinned to.
 *
 * `text_worker` and not a hosted one, because the multi arm has no choice: the
 * sidecar may only reach Ollama on loopback. So the control arm is moved to meet
 * it, never the other way around.
 */
export const EXPERIMENT_PINNED_PROVIDER: LlmProvider = "text_worker";

/** Where the sidecar dials Ollama. Loopback only — the sidecar refuses anything else. */
export function ollamaBaseUrl(env: Record<string, string | undefined> = process.env): string {
  return env.CREW_OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
}

/**
 * The tag both arms of an EXPERIMENT must run.
 *
 * Read from `TEXT_WORKER_MODEL` rather than from a constant of its own, and that
 * is the point: the control arm's model comes from that variable
 * (`supported-providers.ts`), so sourcing the multi arm's from the same place
 * makes them equal BY CONSTRUCTION. A second variable would be a second thing to
 * keep in step, and the day they drifted the experiment would silently compare
 * two models.
 *
 * That argument binds the `ab_split` path and ONLY it. A normal multi run is not
 * a measurement and has nothing to be fair to, so it resolves its tag through
 * `multiAgentModelTag()` instead — see that function for why the two must be
 * allowed to differ.
 */
export function pinnedModelTag(env: Record<string, string | undefined> = process.env): string {
  return getSupportedProviderInfo(EXPERIMENT_PINNED_PROVIDER)?.model ?? env.TEXT_WORKER_MODEL ?? "";
}

/** Whether the pinned provider can actually run here. */
export function pinnedModelAvailable(): boolean {
  return getSupportedProviderInfo(EXPERIMENT_PINNED_PROVIDER)?.status === "available";
}

/**
 * The tag a NORMAL multi-agent run uses — `user_override` and `global_default`.
 *
 * Deliberately NOT the A/B tag. The two answer different questions:
 *
 *  • `pinnedModelTag()` answers "what must both arms run so the experiment
 *    measures orchestration?" — one variable, `TEXT_WORKER_MODEL`, shared with
 *    the control arm BY CONSTRUCTION (see that function).
 *  • this answers "what should the multi-agent product actually run?" — which
 *    has no reason to be the single-agent model at all. The Writer→Editor→QA
 *    loop was validated end-to-end on `qwen3.5:35b-a3b-q4_K_M`; the
 *    single-agent path runs `qwen3:8b` in production and must keep doing so.
 *
 * Sourcing both from one variable is what forced the choice between "change the
 * single-agent model for everyone" and "run multi on an unvalidated model".
 * Splitting them removes the choice.
 *
 * Falls back to `pinnedModelTag(env)` when unset, so an installation that never
 * sets `MULTI_AGENT_MODEL` keeps exactly today's behaviour rather than failing
 * or resolving to an empty tag. A blank/whitespace value is treated as unset —
 * an operator who clears the line means "use the default", not "run the model
 * named empty string".
 */
export function multiAgentModelTag(env: Record<string, string | undefined> = process.env): string {
  const dedicated = env.MULTI_AGENT_MODEL?.trim();
  return dedicated ? dedicated : pinnedModelTag(env);
}

/**
 * The profile handed to the sidecar for ONE multi-agent run, by strategy source.
 *
 * `ab_split` returns the pinned profile UNCHANGED. That is the whole point: an
 * experiment comparing `single` against `multi` is worthless if the arms also
 * differ in the model, so an assigned run keeps running `TEXT_WORKER_MODEL`
 * even when a dedicated multi-agent model is configured. The dedicated tag is
 * for the product, never for the measurement.
 *
 * Everything except the tag is shared with `pinnedInferenceProfile` — same
 * `think: false`, same absence of sampling, same loopback base URL, same
 * unasserted digest — because none of those have any reason to vary by source,
 * and a second profile builder would be the drift this module exists to
 * prevent. `inferenceFingerprint` is computed downstream from whatever this
 * returns, so the recorded provenance is truthful about the tag that actually
 * ran without a second edit anywhere.
 */
export function multiAgentInferenceProfile(
  source: StrategySource,
  env: Record<string, string | undefined> = process.env
): InferenceProfile & { baseUrl: string } {
  const pinned = pinnedInferenceProfile(env);
  if (source === "ab_split") return pinned;
  return { ...pinned, modelTag: multiAgentModelTag(env) };
}

/**
 * The profile the sidecar is handed, and the one recorded for the control arm.
 *
 * One function for both because there is nothing to vary: the same tag, no
 * digest asserted, and no sampling. Two functions would invite the two arms to
 * drift, which is the whole failure this module exists to prevent.
 */
export function pinnedInferenceProfile(
  env: Record<string, string | undefined> = process.env
): InferenceProfile & { baseUrl: string } {
  return {
    modelTag: pinnedModelTag(env),
    // Not resolved on this side. The sidecar reports what Ollama told it; the
    // single-agent path never asks, and reports null honestly.
    modelDigest: null,
    // No SAMPLING keys — see the module docblock. `think: false` is the one
    // pinned setting: it matches the control arm's existing unconditional
    // `think: false`, and as of 2026-09-10 the caller hands this profile to the
    // sidecar for every multi run (`ab_split`, `user_override`,
    // `global_default`), not only the experiment path.
    settings: { think: false },
    baseUrl: ollamaBaseUrl(env),
  };
}

/**
 * How well the model that RAN was established, for one run.
 *
 * Three states and no fourth. The rules, in order:
 *
 *  • the tag that ran is not the tag we pinned  → `unknown`. Something else
 *    answered, and nothing about it has been verified.
 *  • the tags agree and a runtime digest exists → `digest_verified`.
 *  • the tags agree and no digest was resolved  → `tag_matched_only`.
 *
 * A single-agent run can only ever reach the middle case's second branch: there
 * is no digest resolution on the text-worker path, so it reports the tag it was
 * configured with and `tag_matched_only`. That is the truthful ceiling for that
 * path, and it is why a report has to be able to render a `tag-matched only`
 * comparison rather than demanding digests it will never get.
 */
export function modelVerificationFor(
  pinnedTag: string,
  observedTag: string | null,
  observedDigest: string | null
): ModelVerification {
  if (!observedTag || !pinnedTag) return "unknown";
  // The sidecar strips the `ollama/` prefix, but a caller might not.
  const normalize = (tag: string) => tag.replace(/^ollama\//, "").trim();
  if (normalize(observedTag) !== normalize(pinnedTag)) return "unknown";
  return observedDigest ? "digest_verified" : "tag_matched_only";
}
