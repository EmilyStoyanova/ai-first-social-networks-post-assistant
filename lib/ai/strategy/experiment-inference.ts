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
 * The second is handled by PINNING NOTHING, which is the counter-intuitive half
 * and is already written down in `sidecar/crewai/inference_config.py`:
 * `TextWorkerProvider.generate` forwards `temperature`/`maxTokens` into Ollama's
 * `options` only when `request.format` is set, and post generation never sets
 * `format` — only translation does. So the control arm sends no sampling options
 * and inherits the tag's Modelfile defaults. If the sidecar pinned sampling
 * while the control arm pinned none, the arms would differ on temperature while
 * reporting the same model. Sending nothing on BOTH sides is the resolution that
 * requires no change whatsoever to single-agent behaviour.
 *
 * That is why `settings` below is empty and stays empty. It is not an omission
 * to be filled in later: filling it in on one side only is the bug.
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

import type { InferenceProfile } from "@/lib/ai/crew/provenance";
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
 * The tag both arms must run.
 *
 * Read from `TEXT_WORKER_MODEL` rather than from a constant of its own, and that
 * is the point: the control arm's model comes from that variable
 * (`supported-providers.ts`), so sourcing the multi arm's from the same place
 * makes them equal BY CONSTRUCTION. A second variable would be a second thing to
 * keep in step, and the day they drifted the experiment would silently compare
 * two models.
 */
export function pinnedModelTag(env: Record<string, string | undefined> = process.env): string {
  return getSupportedProviderInfo(EXPERIMENT_PINNED_PROVIDER)?.model ?? env.TEXT_WORKER_MODEL ?? "";
}

/** Whether the pinned provider can actually run here. */
export function pinnedModelAvailable(): boolean {
  return getSupportedProviderInfo(EXPERIMENT_PINNED_PROVIDER)?.status === "available";
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
    // Empty, and it must stay empty. See the module docblock.
    settings: {},
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
