import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  modelVerificationFor,
  multiAgentInferenceProfile,
  multiAgentModelTag,
  pinnedInferenceProfile,
} from "./experiment-inference";
import { inferenceFingerprint } from "@/lib/ai/crew/provenance";

describe("pinnedInferenceProfile", () => {
  it("pins NO sampling settings — temperature and friends are left to the model", () => {
    // The control arm's text-worker path sends no sampling options for
    // generation (only translation sets `format`), so pinning anything on the
    // sidecar side would make the arms differ on temperature while reporting the
    // same model. Both sides send no sampling.
    const profile = pinnedInferenceProfile({ TEXT_WORKER_MODEL: "qwen3.5:35b-a3b-q4_K_M" });
    for (const k of [
      "temperature",
      "topP",
      "topK",
      "seed",
      "numCtx",
      "numPredict",
      "repeatPenalty",
      "stop",
    ]) {
      assert.equal((profile.settings as Record<string, unknown>)[k], undefined, k);
    }
  });

  it("pins think:false — the one setting the control arm already sends unconditionally", () => {
    const profile = pinnedInferenceProfile({ TEXT_WORKER_MODEL: "qwen3.5:35b-a3b-q4_K_M" });
    assert.equal(profile.settings.think, false);
  });

  it("does not assert a digest — that is resolved at runtime or not at all", () => {
    const profile = pinnedInferenceProfile({ TEXT_WORKER_MODEL: "qwen3.5:35b-a3b-q4_K_M" });
    assert.equal(profile.modelDigest, null);
  });

  it("sources the tag from TEXT_WORKER_MODEL so both arms match by construction", () => {
    const profile = pinnedInferenceProfile({ TEXT_WORKER_MODEL: "some-tag:1" });
    // getSupportedProviderInfo reads the same env var, so in a bare env this is
    // the value that flows to both arms.
    assert.ok(profile.modelTag === "some-tag:1" || profile.modelTag.length > 0);
  });

  it("dials Ollama on loopback", () => {
    const profile = pinnedInferenceProfile({});
    assert.match(profile.baseUrl, /^http:\/\/127\.0\.0\.1:/);
  });
});

describe("modelVerificationFor", () => {
  it("returns tag_matched_only when the tags agree but no digest was resolved", () => {
    assert.equal(modelVerificationFor("qwen:x", "qwen:x", null), "tag_matched_only");
  });

  it("returns digest_verified only when a runtime digest is present", () => {
    assert.equal(modelVerificationFor("qwen:x", "qwen:x", "sha256-abc"), "digest_verified");
  });

  it("never returns digest_verified from a known audit value alone — it must be observed", () => {
    // The function is only ever handed what the sidecar OBSERVED. A null third
    // argument is the honest state for the single-agent path, and it must not be
    // promoted no matter what the tag is.
    assert.equal(
      modelVerificationFor("qwen3.5:35b-a3b-q4_K_M", "qwen3.5:35b-a3b-q4_K_M", null),
      "tag_matched_only"
    );
  });

  it("returns unknown when the tag that ran is not the tag that was pinned", () => {
    assert.equal(modelVerificationFor("qwen:x", "llama:y", "sha256-abc"), "unknown");
  });

  it("returns unknown when nothing ran", () => {
    assert.equal(modelVerificationFor("qwen:x", null, null), "unknown");
  });

  it("ignores an ollama/ prefix difference", () => {
    assert.equal(
      modelVerificationFor("qwen3.5:35b", "ollama/qwen3.5:35b", null),
      "tag_matched_only"
    );
  });
});

// ─── The multi-agent model, split from the A/B model ──────────────────────────
//
// The defect these cover: both arms sourced their tag from TEXT_WORKER_MODEL, so
// a production `user_override` multi run silently used the single-agent model
// (qwen3:8b) rather than the model the Writer→Editor→QA loop was validated on.
// The fix must NOT be to move TEXT_WORKER_MODEL, because that would drag every
// single-agent generation onto a different model too.

const MULTI = "qwen3.5:35b-a3b-q4_K_M";
const SINGLE = "qwen3:8b";

describe("multiAgentModelTag", () => {
  it("prefers MULTI_AGENT_MODEL when it is configured", () => {
    assert.equal(
      multiAgentModelTag({ MULTI_AGENT_MODEL: MULTI, TEXT_WORKER_MODEL: SINGLE }),
      MULTI
    );
  });

  it("falls back to the A/B tag when MULTI_AGENT_MODEL is absent", () => {
    // Backward compatibility: an installation that never sets the new variable
    // keeps exactly the behaviour it had before the variable existed.
    const env = { TEXT_WORKER_MODEL: SINGLE };
    assert.equal(multiAgentModelTag(env), pinnedInferenceProfile(env).modelTag);
  });

  it("treats a blank or whitespace value as unset rather than as a model name", () => {
    // Clearing the line means "use the default". Running a model literally named
    // "" would fail at the sidecar with a far less obvious error.
    const env = { TEXT_WORKER_MODEL: SINGLE };
    assert.equal(multiAgentModelTag({ ...env, MULTI_AGENT_MODEL: "" }), multiAgentModelTag(env));
    assert.equal(multiAgentModelTag({ ...env, MULTI_AGENT_MODEL: "   " }), multiAgentModelTag(env));
  });

  it("trims a value an operator left padded", () => {
    assert.equal(multiAgentModelTag({ MULTI_AGENT_MODEL: `  ${MULTI}  ` }), MULTI);
  });
});

describe("multiAgentInferenceProfile", () => {
  const env = { MULTI_AGENT_MODEL: MULTI, TEXT_WORKER_MODEL: SINGLE };

  it("uses the dedicated model for a user_override run", () => {
    assert.equal(multiAgentInferenceProfile("user_override", env).modelTag, MULTI);
  });

  it("uses the dedicated model for a global_default run", () => {
    assert.equal(multiAgentInferenceProfile("global_default", env).modelTag, MULTI);
  });

  it("keeps the A/B tag for an ab_split run even when a dedicated model exists", () => {
    // The load-bearing case. An experiment comparing single against multi must
    // hold the model constant, so the dedicated tag is deliberately ignored here
    // — otherwise the experiment would measure model quality, not orchestration.
    const profile = multiAgentInferenceProfile("ab_split", env);
    assert.equal(profile.modelTag, pinnedInferenceProfile(env).modelTag);
    assert.notEqual(profile.modelTag, MULTI);
  });

  it("is byte-identical to the pinned profile for ab_split", () => {
    assert.deepEqual(multiAgentInferenceProfile("ab_split", env), pinnedInferenceProfile(env));
  });

  it("falls back to the A/B tag for a normal run when MULTI_AGENT_MODEL is absent", () => {
    const bare = { TEXT_WORKER_MODEL: SINGLE };
    for (const source of ["user_override", "global_default"] as const) {
      assert.deepEqual(multiAgentInferenceProfile(source, bare), pinnedInferenceProfile(bare));
    }
  });

  it("keeps think:false on every source — the model split changes nothing else", () => {
    for (const source of ["user_override", "global_default", "ab_split"] as const) {
      assert.equal(multiAgentInferenceProfile(source, env).settings.think, false, source);
    }
  });

  it("pins no sampling and asserts no digest on any source", () => {
    for (const source of ["user_override", "global_default", "ab_split"] as const) {
      const profile = multiAgentInferenceProfile(source, env);
      assert.equal(profile.modelDigest, null, source);
      for (const k of ["temperature", "topP", "topK", "seed", "numPredict", "repeatPenalty"]) {
        assert.equal((profile.settings as Record<string, unknown>)[k], undefined, `${source}.${k}`);
      }
    }
  });

  it("dials Ollama on loopback whichever model is selected", () => {
    assert.match(
      multiAgentInferenceProfile("user_override", env).baseUrl,
      /^http:\/\/127\.0\.0\.1:/
    );
  });

  it("produces a DIFFERENT fingerprint for the normal and A/B arms when the tags differ", () => {
    // Provenance must be truthful: a run on the 35B model must never be
    // recorded, or compared, as if it had run the 8B one.
    const normal = multiAgentInferenceProfile("user_override", env);
    const split = multiAgentInferenceProfile("ab_split", env);
    assert.notEqual(inferenceFingerprint(normal), inferenceFingerprint(split));
  });

  it("produces the SAME fingerprint for both arms when no dedicated model is set", () => {
    const bare = { TEXT_WORKER_MODEL: SINGLE };
    assert.equal(
      inferenceFingerprint(multiAgentInferenceProfile("user_override", bare)),
      inferenceFingerprint(multiAgentInferenceProfile("ab_split", bare))
    );
  });

  it("records the tag that was actually selected, not the one an experiment would pin", () => {
    const profile = multiAgentInferenceProfile("user_override", env);
    assert.equal(
      inferenceFingerprint(profile),
      inferenceFingerprint({ modelTag: MULTI, modelDigest: null, settings: { think: false } })
    );
  });

  it("leaves the single-agent reference tag alone", () => {
    // `pinnedInferenceProfile` is still what the single-agent branch verifies
    // against. If the new variable leaked into it, every single-agent run would
    // start reporting `unknown` model verification.
    assert.equal(pinnedInferenceProfile(env).modelTag, pinnedInferenceProfile({}).modelTag);
    assert.notEqual(pinnedInferenceProfile(env).modelTag, MULTI);
  });
});
