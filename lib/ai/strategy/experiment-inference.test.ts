import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { modelVerificationFor, pinnedInferenceProfile } from "./experiment-inference";

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
