import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseRelevanceResponse,
  hasResearchInterests,
  buildRelevanceUserPrompt,
  RelevanceParseError,
  type RelevanceProfile,
  type RelevanceSubject,
} from "./competitor-relevance";

const PROFILE: RelevanceProfile = {
  researchTopics: ["home insulation", "smart thermostats"],
  markets: ["Bulgaria"],
};

const SUBJECT: RelevanceSubject = {
  topic: "Home insulation",
  subtopic: "Attic insulation",
  summary: "A guide to insulating an attic.",
  angle: null,
  keyMessage: null,
  targetAudience: null,
  problemAddressed: null,
  productsServicesMentioned: [],
};

describe("hasResearchInterests", () => {
  it("is true with topics only", () => {
    assert.equal(hasResearchInterests({ researchTopics: ["x"], markets: [] }), true);
  });
  it("is true with markets only", () => {
    assert.equal(hasResearchInterests({ researchTopics: [], markets: ["x"] }), true);
  });
  it("is false with neither", () => {
    assert.equal(hasResearchInterests({ researchTopics: [], markets: [] }), false);
  });
});

describe("parseRelevanceResponse", () => {
  it("accepts a relevant verdict citing a real research topic", () => {
    const reply = JSON.stringify({
      relevance: "relevant",
      reason: "The content is centrally about home insulation.",
      matchedResearchTopics: ["home insulation"],
    });
    const outcome = parseRelevanceResponse(reply, PROFILE);
    assert.equal(outcome.status, "ok");
    if (outcome.status === "ok") {
      assert.equal(outcome.relevance, "relevant");
      assert.deepEqual(outcome.matchedResearchTopics, ["home insulation"]);
    }
  });

  it("accepts out_of_scope with an empty matched list", () => {
    const reply = JSON.stringify({
      relevance: "out_of_scope",
      reason: "Unrelated to any tracked topic.",
      matchedResearchTopics: [],
    });
    const outcome = parseRelevanceResponse(reply, PROFILE);
    assert.equal(outcome.status, "ok");
  });

  it("resolves a matched topic back to its STORED spelling, matching case-insensitively", () => {
    const reply = JSON.stringify({
      relevance: "related",
      reason: "Touches on thermostats in passing.",
      matchedResearchTopics: ["SMART THERMOSTATS"],
    });
    const outcome = parseRelevanceResponse(reply, PROFILE);
    assert.equal(outcome.status, "ok");
    if (outcome.status === "ok") {
      assert.deepEqual(outcome.matchedResearchTopics, ["smart thermostats"]);
    }
  });

  it("rejects an invalid relevance label", () => {
    const reply = JSON.stringify({
      relevance: "very_relevant",
      reason: "x",
      matchedResearchTopics: [],
    });
    assert.equal(parseRelevanceResponse(reply, PROFILE).status, "invalid");
  });

  it("rejects a matched topic that is not in the profile (never silently dropped)", () => {
    const reply = JSON.stringify({
      relevance: "relevant",
      reason: "x",
      matchedResearchTopics: ["home insulation", "solar panels"],
    });
    const outcome = parseRelevanceResponse(reply, PROFILE);
    assert.equal(outcome.status, "invalid");
  });

  it("rejects relevant/related with no matched topic cited", () => {
    const reply = JSON.stringify({ relevance: "relevant", reason: "x", matchedResearchTopics: [] });
    assert.equal(parseRelevanceResponse(reply, PROFILE).status, "invalid");
  });

  it("rejects out_of_scope that cites a matched topic (self-contradiction)", () => {
    const reply = JSON.stringify({
      relevance: "out_of_scope",
      reason: "x",
      matchedResearchTopics: ["home insulation"],
    });
    assert.equal(parseRelevanceResponse(reply, PROFILE).status, "invalid");
  });

  it("rejects a reply with no reason", () => {
    const reply = JSON.stringify({
      relevance: "out_of_scope",
      reason: "",
      matchedResearchTopics: [],
    });
    assert.equal(parseRelevanceResponse(reply, PROFILE).status, "invalid");
  });

  it("rejects prose and malformed JSON", () => {
    assert.equal(parseRelevanceResponse("not json at all", PROFILE).status, "invalid");
    assert.equal(parseRelevanceResponse("{ bad json", PROFILE).status, "invalid");
  });

  it("throws RelevanceParseError on empty response", () => {
    assert.throws(() => parseRelevanceResponse("", PROFILE), RelevanceParseError);
  });
});

describe("buildRelevanceUserPrompt", () => {
  it("renders the subject's fields and the profile's topics/markets", () => {
    const prompt = buildRelevanceUserPrompt(SUBJECT, PROFILE);
    assert.match(prompt, /Home insulation/);
    assert.match(prompt, /home insulation/);
    assert.match(prompt, /Bulgaria/);
  });

  it("never claims relevance is judged — only renders what was extracted", () => {
    const emptySubject: RelevanceSubject = {
      topic: null,
      subtopic: null,
      summary: null,
      angle: null,
      keyMessage: null,
      targetAudience: null,
      problemAddressed: null,
      productsServicesMentioned: [],
    };
    const prompt = buildRelevanceUserPrompt(emptySubject, PROFILE);
    assert.match(prompt, /No intrinsic fields/);
  });
});
