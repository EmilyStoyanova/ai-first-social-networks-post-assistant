import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_TOPICS_PER_GROUP,
  MAX_TOPIC_LENGTH,
  TOPIC_GROUPS,
  TOPIC_GROUP_TIER,
  TOPIC_TIERS,
  checkTopicAddition,
  hasTopicPriorities,
  normalizeTopic,
  resolveTopicPriorities,
  topicIssueMessage,
  topicKey,
  validateTopicGroups,
  type TopicGroups,
} from "./topic-priorities";

function groups(overrides: Partial<TopicGroups> = {}): TopicGroups {
  return {
    topPriorityTopics: [],
    mediumPriorityTopics: [],
    avoidedTopics: [],
    ...overrides,
  };
}

// ─── Normalization ────────────────────────────────────────────────────────────

describe("normalizeTopic", () => {
  it("trims and collapses whitespace", () => {
    assert.equal(normalizeTopic("  бои  "), "бои");
    assert.equal(
      normalizeTopic("смесители   и\tаксесоари\nза баня"),
      "смесители и аксесоари за баня"
    );
  });

  it("collapses a non-breaking space, which a paste from a web page carries", () => {
    // Invisible in the form, so without this it would be a SECOND topic sitting
    // beside the one already in the list.
    assert.equal(normalizeTopic("работно облекло"), "работно облекло");
  });

  it("preserves the user's capitalisation", () => {
    // The stored form is shown back in the form and will be read by a model —
    // only the COMPARISON is case-insensitive.
    assert.equal(normalizeTopic("Бои"), "Бои");
  });

  it("reduces a whitespace-only topic to the empty string", () => {
    assert.equal(normalizeTopic("   \n\t "), "");
  });
});

describe("topicKey", () => {
  it("treats case and spacing differences as the same topic", () => {
    assert.equal(topicKey("  Бои "), topicKey("бои"));
    assert.equal(topicKey("Работно  Облекло"), topicKey("работно облекло"));
  });

  it("keeps genuinely different topics apart", () => {
    assert.notEqual(topicKey("бои"), topicKey("бойлери"));
  });
});

// ─── Reading the configuration ────────────────────────────────────────────────

describe("resolveTopicPriorities", () => {
  it("answers with empty lists for a company that has no brand row", () => {
    assert.deepEqual(resolveTopicPriorities(null), { high: [], medium: [], avoided: [] });
  });

  it("answers with empty lists for a row written before the columns existed", () => {
    // A legacy row selected without the new fields must not need a null check
    // anywhere downstream.
    assert.deepEqual(resolveTopicPriorities({}), { high: [], medium: [], avoided: [] });
    assert.deepEqual(resolveTopicPriorities({ topPriorityTopics: null }), {
      high: [],
      medium: [],
      avoided: [],
    });
  });

  it("keys the lists by tier, not by the column they came from", () => {
    const resolved = resolveTopicPriorities({
      topPriorityTopics: ["бои"],
      mediumPriorityTopics: ["вентилация"],
      avoidedTopics: ["камини"],
    });
    assert.deepEqual(resolved, { high: ["бои"], medium: ["вентилация"], avoided: ["камини"] });
  });

  it("names the third tier for what is CONFIGURED, not for a classifier verdict", () => {
    // An article can be REJECTED as out of scope without matching anything in
    // the avoided list, so the configured list is strictly narrower than the
    // verdict and must not borrow its name. See the module header.
    const resolved = resolveTopicPriorities({ avoidedTopics: ["камини"] });
    assert.deepEqual(Object.keys(resolved), ["high", "medium", "avoided"]);
    assert.equal("rejected" in resolved, false);
    assert.equal("blacklist" in resolved, false);
  });

  it("cleans a stored list that predates validation", () => {
    const resolved = resolveTopicPriorities({
      topPriorityTopics: ["  бои ", "", "   ", "Бои", "бойлери"],
    });
    assert.deepEqual(resolved.high, ["бои", "бойлери"]);
  });

  it("renames each storage group to its tier and claims nothing more", () => {
    assert.deepEqual(TOPIC_GROUP_TIER, {
      topPriorityTopics: "high",
      mediumPriorityTopics: "medium",
      avoidedTopics: "avoided",
    });
  });

  it("lists the tiers in rank order, matching the storage groups", () => {
    assert.deepEqual(TOPIC_TIERS, ["high", "medium", "avoided"]);
    assert.deepEqual(
      TOPIC_GROUPS.map((group) => TOPIC_GROUP_TIER[group]),
      [...TOPIC_TIERS]
    );
  });
});

describe("hasTopicPriorities", () => {
  it("is false when nothing is configured", () => {
    assert.equal(hasTopicPriorities(resolveTopicPriorities(null)), false);
  });

  it("is true when any single group has a topic", () => {
    assert.equal(hasTopicPriorities(resolveTopicPriorities({ avoidedTopics: ["камини"] })), true);
  });
});

// ─── Validation ───────────────────────────────────────────────────────────────

describe("validateTopicGroups", () => {
  it("accepts an empty configuration", () => {
    assert.deepEqual(validateTopicGroups(groups()), []);
  });

  it("accepts three populated, disjoint lists", () => {
    const issues = validateTopicGroups(
      groups({
        topPriorityTopics: ["бои", "бойлери"],
        mediumPriorityTopics: ["вентилация", "климатизация"],
        avoidedTopics: ["камини", "тухли"],
      })
    );
    assert.deepEqual(issues, []);
  });

  it("rejects an empty or whitespace-only topic", () => {
    const issues = validateTopicGroups(groups({ topPriorityTopics: ["бои", "   "] }));
    assert.deepEqual(issues, [{ code: "EMPTY_TOPIC", group: "topPriorityTopics" }]);
  });

  it("accepts a topic at the length limit and rejects one past it", () => {
    assert.deepEqual(
      validateTopicGroups(groups({ topPriorityTopics: ["a".repeat(MAX_TOPIC_LENGTH)] })),
      []
    );
    const issues = validateTopicGroups(
      groups({ topPriorityTopics: ["a".repeat(MAX_TOPIC_LENGTH + 1)] })
    );
    assert.equal(issues[0]?.code, "TOPIC_TOO_LONG");
  });

  it("measures length after normalization, not before", () => {
    // Padding is not content — trimming happens first, so a padded topic that
    // fits is accepted.
    const padded = `  ${"a".repeat(MAX_TOPIC_LENGTH)}  `;
    assert.deepEqual(validateTopicGroups(groups({ topPriorityTopics: [padded] })), []);
  });

  it("rejects more topics than a group may hold", () => {
    const many = Array.from({ length: MAX_TOPICS_PER_GROUP + 1 }, (_, i) => `topic-${i}`);
    const issues = validateTopicGroups(groups({ mediumPriorityTopics: many }));
    assert.ok(issues.some((i) => i.code === "TOO_MANY_TOPICS"));
  });

  it("accepts exactly the maximum number of topics", () => {
    const many = Array.from({ length: MAX_TOPICS_PER_GROUP }, (_, i) => `topic-${i}`);
    assert.deepEqual(validateTopicGroups(groups({ mediumPriorityTopics: many })), []);
  });

  it("rejects a duplicate within one group, ignoring case and spacing", () => {
    const issues = validateTopicGroups(groups({ topPriorityTopics: ["бои", "  Бои "] }));
    assert.deepEqual(issues, [
      { code: "DUPLICATE_TOPIC", group: "topPriorityTopics", topic: "Бои" },
    ]);
  });

  it("does not treat a topic that merely starts with another as a duplicate", () => {
    assert.deepEqual(
      validateTopicGroups(groups({ topPriorityTopics: ["бои", "бои за стени"] })),
      []
    );
  });

  it("rejects a topic that appears in two groups", () => {
    const issues = validateTopicGroups(
      groups({ topPriorityTopics: ["бои"], avoidedTopics: ["Бои"] })
    );
    assert.deepEqual(issues, [
      {
        code: "TOPIC_IN_MULTIPLE_GROUPS",
        group: "avoidedTopics",
        topic: "Бои",
        otherGroup: "topPriorityTopics",
      },
    ]);
  });

  it("reports the conflict against the earlier group whichever way round it is entered", () => {
    // The rank order is fixed, so the report is deterministic and does not
    // depend on which list the user typed into last.
    const issues = validateTopicGroups(
      groups({ mediumPriorityTopics: ["бои"], topPriorityTopics: ["бои"] })
    );
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.code, "TOPIC_IN_MULTIPLE_GROUPS");
    assert.equal(issues[0].group, "mediumPriorityTopics");
  });

  it("reports every problem rather than stopping at the first", () => {
    const issues = validateTopicGroups(
      groups({
        topPriorityTopics: ["бои", "бои"],
        avoidedTopics: ["", "бои"],
      })
    );
    assert.deepEqual(issues.map((i) => i.code).sort(), [
      "DUPLICATE_TOPIC",
      "EMPTY_TOPIC",
      "TOPIC_IN_MULTIPLE_GROUPS",
    ]);
  });

  it("names the offending topic in every message", () => {
    for (const issue of validateTopicGroups(
      groups({ topPriorityTopics: ["бои"], avoidedTopics: ["бои"] })
    )) {
      assert.ok(topicIssueMessage(issue).includes("бои"));
    }
  });

  it("covers each group in rank order", () => {
    assert.deepEqual(TOPIC_GROUPS, ["topPriorityTopics", "mediumPriorityTopics", "avoidedTopics"]);
  });
});

// ─── Adding one topic ─────────────────────────────────────────────────────────

describe("checkTopicAddition", () => {
  it("accepts a new topic, returning it normalized", () => {
    const result = checkTopicAddition("  смесители  и аксесоари  ", "topPriorityTopics", groups());
    assert.deepEqual(result, { ok: true, topic: "смесители и аксесоари" });
  });

  it("refuses an empty topic", () => {
    assert.deepEqual(checkTopicAddition("   ", "topPriorityTopics", groups()), {
      ok: false,
      reason: "empty",
    });
  });

  it("refuses a topic past the length limit", () => {
    const result = checkTopicAddition("a".repeat(MAX_TOPIC_LENGTH + 1), "avoidedTopics", groups());
    assert.deepEqual(result, { ok: false, reason: "too_long" });
  });

  it("refuses a duplicate of a topic already in the same group", () => {
    const result = checkTopicAddition(
      " БОИ ",
      "topPriorityTopics",
      groups({ topPriorityTopics: ["бои"] })
    );
    assert.deepEqual(result, { ok: false, reason: "duplicate" });
  });

  it("refuses a topic held by another group, naming that group", () => {
    const result = checkTopicAddition(
      "бои",
      "avoidedTopics",
      groups({ topPriorityTopics: ["Бои"] })
    );
    assert.deepEqual(result, {
      ok: false,
      reason: "conflict",
      otherGroup: "topPriorityTopics",
    });
  });

  it("refuses once the group is full", () => {
    const full = Array.from({ length: MAX_TOPICS_PER_GROUP }, (_, i) => `topic-${i}`);
    const result = checkTopicAddition("бои", "mediumPriorityTopics", {
      ...groups(),
      mediumPriorityTopics: full,
    });
    assert.deepEqual(result, { ok: false, reason: "limit_reached" });
  });

  it("agrees with validateTopicGroups — anything it accepts leaves the lists valid", () => {
    const current = groups({
      topPriorityTopics: ["бои"],
      mediumPriorityTopics: ["вентилация"],
      avoidedTopics: ["камини"],
    });
    const result = checkTopicAddition("бойлери", "topPriorityTopics", current);
    assert.equal(result.ok, true);
    assert.ok(result.ok);
    assert.deepEqual(
      validateTopicGroups({
        ...current,
        topPriorityTopics: [...current.topPriorityTopics, result.topic],
      }),
      []
    );
  });
});
