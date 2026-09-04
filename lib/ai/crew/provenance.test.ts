import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compareInference,
  inferenceFingerprint,
  isAcceptableQaState,
  type InferenceProfile,
} from "./provenance";

const QWEN: InferenceProfile = {
  modelTag: "qwen3.5:35b-a3b-q4_K_M",
  modelDigest: "sha256:abc123",
  settings: { temperature: 0.85, numPredict: 1024, topP: 0.9 },
};

describe("inferenceFingerprint", () => {
  it("is independent of the order the settings object was built in", () => {
    // The property that makes the fingerprint usable at all: two code paths
    // (the control arm's provider, the sidecar's config) build their objects in
    // whatever order suits them, and identical inference must fingerprint
    // identically or the report refuses a comparison that is in fact valid.
    const a: InferenceProfile = {
      modelTag: QWEN.modelTag,
      modelDigest: QWEN.modelDigest,
      settings: { topP: 0.9, numPredict: 1024, temperature: 0.85 },
    };
    assert.equal(inferenceFingerprint(a), inferenceFingerprint(QWEN));
  });

  it("distinguishes an ABSENT parameter from one set to a default", () => {
    // The defect this guards: the control arm currently drops its sampling
    // params on the text-worker path, so Ollama uses the Modelfile default.
    // "we did not send temperature" and "we sent temperature=0.85" are
    // different facts about what ran, and must not fingerprint alike.
    const unpinned: InferenceProfile = { ...QWEN, settings: { numPredict: 1024, topP: 0.9 } };
    assert.notEqual(inferenceFingerprint(unpinned), inferenceFingerprint(QWEN));
  });

  it("ignores keys explicitly set to undefined", () => {
    const withUndefined: InferenceProfile = {
      ...QWEN,
      settings: { ...QWEN.settings, seed: undefined },
    };
    assert.equal(inferenceFingerprint(withUndefined), inferenceFingerprint(QWEN));
  });
});

describe("compareInference — the hard report guard", () => {
  it("compares two arms whose PROVIDER LABELS differ but whose inference is identical", () => {
    // The whole point. Control reaches Qwen via text_worker; multi reaches the
    // same Qwen via the sidecar. The labels differ legitimately and are
    // preserved; equality is asserted here instead.
    const verdict = compareInference(QWEN, { ...QWEN, settings: { ...QWEN.settings } });
    assert.deepEqual(verdict, { comparable: true, basis: "digest-verified" });
  });

  it("REFUSES a comparison whose temperature differs, even on the same tag and digest", () => {
    const hotter: InferenceProfile = {
      ...QWEN,
      settings: { ...QWEN.settings, temperature: 0.7 },
    };
    const verdict = compareInference(QWEN, hotter);
    assert.equal(verdict.comparable, false);
    assert.match(verdict.comparable === false ? verdict.reason : "", /Sampling settings differ/);
  });

  it("REFUSES a comparison across different model tags", () => {
    const other: InferenceProfile = { ...QWEN, modelTag: "qwen3:8b" };
    const verdict = compareInference(QWEN, other);
    assert.equal(verdict.comparable, false);
    assert.match(verdict.comparable === false ? verdict.reason : "", /Model tags differ/);
  });

  it("REFUSES a comparison across different digests of one tag", () => {
    const repulled: InferenceProfile = { ...QWEN, modelDigest: "sha256:def456" };
    const verdict = compareInference(QWEN, repulled);
    assert.equal(verdict.comparable, false);
    assert.match(verdict.comparable === false ? verdict.reason : "", /digests differ/);
  });

  it("labels a digest-less comparison 'tag-matched only' rather than promoting it", () => {
    const noDigest: InferenceProfile = { ...QWEN, modelDigest: null };
    const verdict = compareInference(noDigest, { ...noDigest, settings: { ...noDigest.settings } });
    assert.deepEqual(verdict, { comparable: true, basis: "tag-matched only" });
  });
});

describe("isAcceptableQaState — the asymmetry", () => {
  it("accepts pass, and accepts unavailable", () => {
    assert.equal(isAcceptableQaState("pass"), true);
    // A critic that COULD NOT RUN said nothing; the gates are the whole verdict.
    assert.equal(isAcceptableQaState("unavailable"), true);
  });

  it("refuses rejected_unroutable — a critic that ran and said no", () => {
    assert.equal(isAcceptableQaState("rejected_unroutable"), false);
  });

  it("refuses a mid-loop verdict that leaked out", () => {
    assert.equal(isAcceptableQaState("revise_writer"), false);
    assert.equal(isAcceptableQaState("revise_editor"), false);
  });
});
