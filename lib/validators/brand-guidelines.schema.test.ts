import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { updateBrandGuidelinesSchema } from "./brand-guidelines.schema";
import { MAX_TOPICS_PER_GROUP, MAX_TOPIC_LENGTH } from "@/lib/ai/topic-priorities";

/** The payload the Brand Settings form sends, with the topics under test. */
function payload(overrides: Record<string, unknown> = {}) {
  return {
    automationMode: "semi_automated",
    defaultLang: "bg",
    forbiddenWords: [],
    competitors: [],
    ...overrides,
  };
}

function pathsOf(result: ReturnType<typeof updateBrandGuidelinesSchema.safeParse>) {
  return result.success ? [] : result.error.issues.map((i) => i.path.join("."));
}

describe("updateBrandGuidelinesSchema — topic priorities", () => {
  it("accepts and returns all three lists", () => {
    const parsed = updateBrandGuidelinesSchema.safeParse(
      payload({
        topPriorityTopics: ["бои", "смесители и аксесоари за баня", "бойлери"],
        mediumPriorityTopics: ["вентилация", "климатизация"],
        avoidedTopics: ["камини", "тухли"],
      })
    );

    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.data?.topPriorityTopics, [
      "бои",
      "смесители и аксесоари за баня",
      "бойлери",
    ]);
    assert.deepEqual(parsed.data?.mediumPriorityTopics, ["вентилация", "климатизация"]);
    assert.deepEqual(parsed.data?.avoidedTopics, ["камини", "тухли"]);
  });

  it("keeps the three lists separate", () => {
    // The whole point of the feature: a topic saved as TOP must not leak into
    // another group on the way through.
    const parsed = updateBrandGuidelinesSchema.safeParse(
      payload({ topPriorityTopics: ["бои"], mediumPriorityTopics: [], avoidedTopics: ["камини"] })
    );
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.data?.mediumPriorityTopics, []);
  });

  it("accepts empty lists — the default configuration", () => {
    const parsed = updateBrandGuidelinesSchema.safeParse(
      payload({ topPriorityTopics: [], mediumPriorityTopics: [], avoidedTopics: [] })
    );
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.data?.topPriorityTopics, []);
  });

  it("accepts a payload that omits the topics entirely", () => {
    // A client that predates this feature must keep saving. Omitted means "not
    // edited", so nothing is written for those groups.
    const parsed = updateBrandGuidelinesSchema.safeParse(payload());
    assert.equal(parsed.success, true);
    assert.equal(parsed.data?.topPriorityTopics, undefined);
    assert.equal(parsed.data?.avoidedTopics, undefined);
  });

  it("trims and collapses whitespace on the server, not only in the UI", () => {
    const parsed = updateBrandGuidelinesSchema.safeParse(
      payload({ topPriorityTopics: ["  бои  ", "смесители   и  аксесоари"] })
    );
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.data?.topPriorityTopics, ["бои", "смесители и аксесоари"]);
  });

  it("rejects an empty or whitespace-only topic", () => {
    const parsed = updateBrandGuidelinesSchema.safeParse(
      payload({ mediumPriorityTopics: ["вентилация", "   "] })
    );
    assert.equal(parsed.success, false);
    assert.deepEqual(pathsOf(parsed), ["mediumPriorityTopics"]);
  });

  it("rejects a duplicate inside one group, however it is cased or spaced", () => {
    const parsed = updateBrandGuidelinesSchema.safeParse(
      payload({ avoidedTopics: ["камини", " Камини "] })
    );
    assert.equal(parsed.success, false);
    assert.deepEqual(pathsOf(parsed), ["avoidedTopics"]);
  });

  it("rejects the same topic in two groups", () => {
    // Ambiguous configuration: "бои" cannot be both HIGH and REJECTED, and
    // resolving it silently would make the classifier's answer arbitrary.
    const parsed = updateBrandGuidelinesSchema.safeParse(
      payload({ topPriorityTopics: ["бои"], avoidedTopics: ["Бои"] })
    );
    assert.equal(parsed.success, false);
    assert.deepEqual(pathsOf(parsed), ["avoidedTopics"]);
    assert.match(parsed.error?.issues[0]?.message ?? "", /already in topPriorityTopics/);
  });

  it("rejects a topic longer than the limit", () => {
    const parsed = updateBrandGuidelinesSchema.safeParse(
      payload({ topPriorityTopics: ["a".repeat(MAX_TOPIC_LENGTH + 1)] })
    );
    assert.equal(parsed.success, false);
  });

  it("accepts a topic exactly at the length limit", () => {
    const parsed = updateBrandGuidelinesSchema.safeParse(
      payload({ topPriorityTopics: ["a".repeat(MAX_TOPIC_LENGTH)] })
    );
    assert.equal(parsed.success, true);
  });

  it("rejects more topics than a group may hold, and accepts exactly the limit", () => {
    const at = Array.from({ length: MAX_TOPICS_PER_GROUP }, (_, i) => `topic-${i}`);
    assert.equal(
      updateBrandGuidelinesSchema.safeParse(payload({ avoidedTopics: at })).success,
      true
    );

    const over = [...at, "one-too-many"];
    const parsed = updateBrandGuidelinesSchema.safeParse(payload({ avoidedTopics: over }));
    assert.equal(parsed.success, false);
    assert.deepEqual(pathsOf(parsed), ["avoidedTopics"]);
  });

  it("rejects a non-string topic", () => {
    assert.equal(
      updateBrandGuidelinesSchema.safeParse(payload({ topPriorityTopics: ["бои", 7] })).success,
      false
    );
  });
});

describe("updateBrandGuidelinesSchema — existing fields", () => {
  it("still accepts the pre-existing brand payload unchanged", () => {
    const parsed = updateBrandGuidelinesSchema.safeParse({
      automationMode: "fully_automated",
      defaultLang: "en",
      logoUrl: "https://example.com/logo.png",
      primaryColor: "#1A2B3C",
      secondaryColor: "#ffffff",
      fontFamily: "Inter, sans-serif",
      toneOfVoice: "Professional",
      companyDescription: "A company.",
      targetAudience: "Builders.",
      forbiddenWords: ["cheap", "free"],
      competitors: ["Competitor A"],
    });

    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.data?.forbiddenWords, ["cheap", "free"]);
    assert.equal(parsed.data?.primaryColor, "#1A2B3C");
    assert.equal(parsed.data?.automationMode, "fully_automated");
  });

  it("still rejects a bad hex colour", () => {
    assert.equal(
      updateBrandGuidelinesSchema.safeParse(payload({ primaryColor: "red" })).success,
      false
    );
  });

  it("still rejects a bad logo URL", () => {
    assert.equal(
      updateBrandGuidelinesSchema.safeParse(payload({ logoUrl: "not-a-url" })).success,
      false
    );
  });

  it("still rejects an over-long company description", () => {
    assert.equal(
      updateBrandGuidelinesSchema.safeParse(payload({ companyDescription: "x".repeat(2001) }))
        .success,
      false
    );
  });

  it("still leaves forbidden words untouched — they are not topics", () => {
    // Forbidden words are matched literally against generated text, so they are
    // deliberately NOT normalized or de-duplicated the way topics are.
    const parsed = updateBrandGuidelinesSchema.safeParse(
      payload({ forbiddenWords: ["  cheap  ", "cheap"] })
    );
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.data?.forbiddenWords, ["  cheap  ", "cheap"]);
  });
});
