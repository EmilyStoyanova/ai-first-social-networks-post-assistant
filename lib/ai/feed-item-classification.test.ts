import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CLASSIFICATION_ATTEMPTS,
  MAX_CLASSIFICATION_CONTENT_CHARS,
  MAX_STORED_MATCHED_TOPICS,
  MAX_STORED_REASON_CHARS,
  buildClassificationRepairPrompt,
  buildClassificationSystemPrompt,
  classificationExcerpt,
  classificationFieldsForCreate,
  classificationFieldsForUpdate,
  classificationMode,
  classificationSelectableWhere,
  classifyInput,
  computeClassificationHash,
  isClassifiableSourceType,
  parseClassificationResponse,
  topicsFingerprint,
} from "./feed-item-classification";
import { resolveTopicPriorities, type TopicPriorities } from "./topic-priorities";

const SCOPED: TopicPriorities = resolveTopicPriorities({
  topPriorityTopics: ["бои", "бойлери"],
  mediumPriorityTopics: ["вентилация"],
  avoidedTopics: ["камини", "маси"],
});

const BLACKLIST_ONLY: TopicPriorities = resolveTopicPriorities({ avoidedTopics: ["камини"] });
const NONE: TopicPriorities = resolveTopicPriorities(null);

const reply = (obj: unknown) => JSON.stringify(obj);

describe("isClassifiableSourceType", () => {
  it("covers article feeds only", () => {
    assert.equal(isClassifiableSourceType("rss"), true);
    for (const type of ["prompt", "product_page", "calendar_event"]) {
      assert.equal(isClassifiableSourceType(type), false);
    }
  });
});

describe("classificationMode", () => {
  it("is `none` for a company that configured nothing", () => {
    assert.equal(classificationMode(NONE), "none");
  });

  it("is `blacklist_only` when only avoided topics exist", () => {
    assert.equal(classificationMode(BLACKLIST_ONLY), "blacklist_only");
  });

  it("is `scoped` as soon as one HIGH or MEDIUM topic exists", () => {
    assert.equal(classificationMode(SCOPED), "scoped");
    assert.equal(
      classificationMode(resolveTopicPriorities({ mediumPriorityTopics: ["вентилация"] })),
      "scoped"
    );
  });
});

describe("classifyInput / classificationExcerpt", () => {
  it("classifies what the stored text can support", () => {
    assert.equal(classifyInput({ title: "t", body: "b" }), "full");
    assert.equal(classifyInput({ title: "t", body: "   " }), "title_only");
    assert.equal(classifyInput({ title: null, body: null }), "empty");
  });

  it("caps the body it sends", () => {
    const long = "a".repeat(MAX_CLASSIFICATION_CONTENT_CHARS + 500);
    assert.equal(classificationExcerpt(long).length, MAX_CLASSIFICATION_CONTENT_CHARS);
  });
});

// ─── Idempotency ──────────────────────────────────────────────────────────────

describe("topicsFingerprint", () => {
  it("ignores order and case — reordering chips is not a change", () => {
    const a = resolveTopicPriorities({ topPriorityTopics: ["бои", "бойлери"] });
    const b = resolveTopicPriorities({ topPriorityTopics: ["Бойлери", "БОИ"] });
    assert.equal(topicsFingerprint(a), topicsFingerprint(b));
  });

  it("changes when a topic is added, removed or edited", () => {
    const base = resolveTopicPriorities({ topPriorityTopics: ["бои"] });
    for (const changed of [
      resolveTopicPriorities({ topPriorityTopics: ["бои", "бойлери"] }),
      resolveTopicPriorities({ topPriorityTopics: [] }),
      resolveTopicPriorities({ topPriorityTopics: ["боя"] }),
    ]) {
      assert.notEqual(topicsFingerprint(base), topicsFingerprint(changed));
    }
  });

  it("distinguishes the group a topic sits in", () => {
    const high = resolveTopicPriorities({ topPriorityTopics: ["бои"] });
    const avoided = resolveTopicPriorities({ avoidedTopics: ["бои"] });
    assert.notEqual(topicsFingerprint(high), topicsFingerprint(avoided));
  });
});

describe("computeClassificationHash", () => {
  const text = { title: "Латекс за детска стая", body: "Как да изберем." };

  it("is stable for the same text and configuration — the idempotency contract", () => {
    assert.equal(computeClassificationHash(text, SCOPED), computeClassificationHash(text, SCOPED));
  });

  it("changes when the article text changes", () => {
    assert.notEqual(
      computeClassificationHash(text, SCOPED),
      computeClassificationHash({ ...text, body: "Друг текст." }, SCOPED)
    );
  });

  it("changes when the topic configuration changes", () => {
    const more = resolveTopicPriorities({
      topPriorityTopics: ["бои", "бойлери", "смесители"],
      mediumPriorityTopics: ["вентилация"],
      avoidedTopics: ["камини", "маси"],
    });
    assert.notEqual(computeClassificationHash(text, SCOPED), computeClassificationHash(text, more));
  });

  it("ignores text beyond the cap — what is not sent cannot change the answer", () => {
    const body = "b".repeat(MAX_CLASSIFICATION_CONTENT_CHARS);
    assert.equal(
      computeClassificationHash({ title: "t", body }, SCOPED),
      computeClassificationHash({ title: "t", body: body + "ignored tail" }, SCOPED)
    );
  });
});

// ─── Lifecycle / lease recovery ───────────────────────────────────────────────

describe("classificationSelectableWhere", () => {
  const now = new Date("2026-08-17T12:00:00Z");
  const where = classificationSelectableWhere(now);

  it("selects pending and failed items — a failure is retryable", () => {
    const statuses = where.OR as Array<Record<string, unknown>>;
    assert.deepEqual(statuses[0].classificationStatus, { in: ["pending", "failed"] });
  });

  it("reclaims a crashed run's claim once its lease has expired", () => {
    const statuses = where.OR as Array<Record<string, unknown>>;
    assert.equal(statuses[1].classificationStatus, "classifying");
    assert.deepEqual(statuses[1].classificationLeaseExpiresAt, { lt: now });
  });

  it("never selects a LIVE claim", () => {
    // The only `classifying` branch carries the expired-lease condition, so an
    // in-flight item cannot be picked up a second time.
    const statuses = where.OR as Array<Record<string, unknown>>;
    const live = statuses.filter(
      (s) => s.classificationStatus === "classifying" && !s.classificationLeaseExpiresAt
    );
    assert.deepEqual(live, []);
  });

  it("stops selecting an item once its attempt budget is spent", () => {
    assert.deepEqual(where.classificationAttemptCount, { lt: MAX_CLASSIFICATION_ATTEMPTS });
  });
});

describe("classificationFieldsForCreate / ForUpdate", () => {
  it("queues a new article and leaves a non-classifiable one alone", () => {
    assert.deepEqual(classificationFieldsForCreate(true), { classificationStatus: "pending" });
    assert.deepEqual(classificationFieldsForCreate(false), {});
  });

  it("queues an existing article that has never been classified", () => {
    assert.deepEqual(
      classificationFieldsForUpdate(true, {
        classificationStatus: null,
        classificationHash: null,
        classificationAttemptCount: 0,
      }),
      { classificationStatus: "pending" }
    );
  });

  it("leaves a settled or in-flight row untouched — no reset of attempts or errors", () => {
    // A blind re-queue on every ingest is what turns a failed item into an
    // infinite retry loop; the drain owns that decision, not ingestion.
    for (const status of ["pending", "classifying", "completed", "skipped", "failed"]) {
      assert.deepEqual(
        classificationFieldsForUpdate(true, {
          classificationStatus: status,
          classificationHash: "h",
          classificationAttemptCount: 2,
        }),
        {}
      );
    }
  });

  it("clears the verdict when a source stops being classifiable", () => {
    const cleared = classificationFieldsForUpdate(false, {
      classificationStatus: "completed",
      classificationHash: "h",
      classificationAttemptCount: 1,
    });
    assert.equal(cleared.classificationStatus, null);
    assert.equal(cleared.classification, null);
    assert.deepEqual(cleared.classificationMatchedTopics, []);
  });
});

// ─── The reply contract ───────────────────────────────────────────────────────

describe("parseClassificationResponse", () => {
  it("accepts a well-formed HIGH verdict", () => {
    const out = parseClassificationResponse(
      reply({
        classification: "HIGH",
        rejectionReason: null,
        matchedTopics: ["бои"],
        reason: "Article about choosing paint.",
      }),
      SCOPED
    );
    assert.equal(out.status, "ok");
    assert.ok(out.status === "ok");
    assert.equal(out.classification, "HIGH");
    assert.deepEqual(out.matchedTopics, ["бои"]);
  });

  it("accepts a BLACKLIST rejection citing an avoided topic", () => {
    const out = parseClassificationResponse(
      reply({
        classification: "REJECTED",
        rejectionReason: "BLACKLIST",
        matchedTopics: ["камини"],
        reason: "The article is about fireplaces.",
      }),
      SCOPED
    );
    assert.ok(out.status === "ok");
    assert.equal(out.rejectionReason, "BLACKLIST");
  });

  it("accepts OUT_OF_SCOPE with no matched topics", () => {
    const out = parseClassificationResponse(
      reply({
        classification: "REJECTED",
        rejectionReason: "OUT_OF_SCOPE",
        matchedTopics: [],
        reason: "About cryptocurrency.",
      }),
      SCOPED
    );
    assert.ok(out.status === "ok");
    assert.equal(out.rejectionReason, "OUT_OF_SCOPE");
  });

  it("rejects prose instead of JSON, with feedback a repair can use", () => {
    const out = parseClassificationResponse("This looks like a paint article.", SCOPED);
    assert.equal(out.status, "invalid");
    assert.ok(out.status === "invalid");
    assert.match(out.feedback, /JSON/);
  });

  it("throws on an empty response rather than inventing a verdict", () => {
    assert.throws(() => parseClassificationResponse("", SCOPED), /empty response/);
  });

  it("refuses a REJECTED with no reason", () => {
    const out = parseClassificationResponse(
      reply({ classification: "REJECTED", rejectionReason: null, matchedTopics: [], reason: "x" }),
      SCOPED
    );
    assert.equal(out.status, "invalid");
  });

  it("refuses a HIGH that carries a rejection reason", () => {
    const out = parseClassificationResponse(
      reply({
        classification: "HIGH",
        rejectionReason: "BLACKLIST",
        matchedTopics: ["бои"],
        reason: "x",
      }),
      SCOPED
    );
    assert.equal(out.status, "invalid");
  });

  it("refuses HIGH that cites no configured top-priority topic", () => {
    const out = parseClassificationResponse(
      reply({
        classification: "HIGH",
        rejectionReason: null,
        matchedTopics: ["вентилация"],
        reason: "x",
      }),
      SCOPED
    );
    assert.equal(out.status, "invalid");
  });

  it("refuses BLACKLIST that cites no configured avoided topic", () => {
    // This is the guard against an incidental mention becoming a rejection: the
    // model must name the avoided topic it says the article is ABOUT.
    const out = parseClassificationResponse(
      reply({
        classification: "REJECTED",
        rejectionReason: "BLACKLIST",
        matchedTopics: ["бои"],
        reason: "x",
      }),
      SCOPED
    );
    assert.equal(out.status, "invalid");
    assert.ok(out.status === "invalid");
    assert.match(out.feedback, /passing mention/);
  });

  it("refuses an invented topic instead of quietly dropping it", () => {
    // Dropping it would leave the VERDICT standing on a topic the company never
    // configured, which is exactly how an unrelated article becomes HIGH.
    const out = parseClassificationResponse(
      reply({
        classification: "HIGH",
        rejectionReason: null,
        matchedTopics: ["бои", "нещо измислено"],
        reason: "x",
      }),
      SCOPED
    );
    assert.equal(out.status, "invalid");
    assert.ok(out.status === "invalid");
    assert.match(out.problem, /нещо измислено/);
  });

  it("resolves a matched topic back to its stored spelling", () => {
    const out = parseClassificationResponse(
      reply({ classification: "HIGH", rejectionReason: null, matchedTopics: ["БОИ"], reason: "x" }),
      SCOPED
    );
    assert.ok(out.status === "ok");
    assert.deepEqual(out.matchedTopics, ["бои"]);
  });

  it("caps the stored explanation", () => {
    const out = parseClassificationResponse(
      reply({
        classification: "HIGH",
        rejectionReason: null,
        matchedTopics: ["бои"],
        reason: "x".repeat(MAX_STORED_REASON_CHARS + 200),
      }),
      SCOPED
    );
    assert.ok(out.status === "ok");
    assert.equal(out.reason.length, MAX_STORED_REASON_CHARS);
  });

  it("refuses OUT_OF_SCOPE in blacklist-only mode", () => {
    // With no wanted topics configured nothing can be out of scope — rejecting
    // everything would be a silent content blackout.
    const out = parseClassificationResponse(
      reply({
        classification: "REJECTED",
        rejectionReason: "OUT_OF_SCOPE",
        matchedTopics: [],
        reason: "x",
      }),
      BLACKLIST_ONLY
    );
    assert.equal(out.status, "invalid");
  });

  it("accepts a bare MEDIUM in blacklist-only mode — the neutral answer", () => {
    const out = parseClassificationResponse(
      reply({
        classification: "MEDIUM",
        rejectionReason: null,
        matchedTopics: [],
        reason: "Not about anything avoided.",
      }),
      BLACKLIST_ONLY
    );
    assert.ok(out.status === "ok");
    assert.equal(out.classification, "MEDIUM");
  });

  it("still requires a cited medium topic in scoped mode", () => {
    const out = parseClassificationResponse(
      reply({ classification: "MEDIUM", rejectionReason: null, matchedTopics: [], reason: "x" }),
      SCOPED
    );
    assert.equal(out.status, "invalid");
  });

  it("caps stored matched topics without stopping the scan for invented ones", () => {
    const many = resolveTopicPriorities({
      topPriorityTopics: Array.from(
        { length: MAX_STORED_MATCHED_TOPICS + 2 },
        (_, i) => `тема ${i}`
      ),
    });
    const all = Array.from({ length: MAX_STORED_MATCHED_TOPICS + 2 }, (_, i) => `тема ${i}`);

    const capped = parseClassificationResponse(
      reply({ classification: "HIGH", rejectionReason: null, matchedTopics: all, reason: "x" }),
      many
    );
    assert.ok(capped.status === "ok");
    assert.equal(capped.matchedTopics.length, MAX_STORED_MATCHED_TOPICS);

    // The invented topic sits past the cap, so a scan that stopped at the cap
    // would never see it.
    const smuggled = parseClassificationResponse(
      reply({
        classification: "HIGH",
        rejectionReason: null,
        matchedTopics: [...all, "измислена"],
        reason: "x",
      }),
      many
    );
    assert.equal(smuggled.status, "invalid");
  });
});

// ─── Precision: a match must be direct, not merely same-industry ──────────────
//
// The regression these guard is real: for a company whose top priority topics are
// бои / смесители и аксесоари за баня / бойлери, an article about free
// fast-growing TREES came back HIGH — matched on "this is a home-and-garden
// company" rather than on any configured topic.
//
// The semantic judgement itself belongs to the model, so what is asserted here is
// the machinery around it: which replies may be STORED as a verdict, and that the
// prompt states the rule the model has to follow. A verdict that rests on a topic
// the company never configured can no longer be persisted, and a category label
// standing in for a topic is exactly that case.

const DOMESTICO: TopicPriorities = resolveTopicPriorities({
  topPriorityTopics: ["бои", "смесители и аксесоари за баня", "бойлери"],
  mediumPriorityTopics: ["вентилация"],
  avoidedTopics: ["камини"],
});

describe("classification precision — direct match required", () => {
  it("accepts a genuine paint article as HIGH", () => {
    const out = parseClassificationResponse(
      reply({
        classification: "HIGH",
        rejectionReason: null,
        matchedTopics: ["бои"],
        reason: "Как да изберем латекс за детската стая.",
      }),
      DOMESTICO
    );
    assert.ok(out.status === "ok");
    assert.equal(out.classification, "HIGH");
    assert.deepEqual(out.matchedTopics, ["бои"]);
  });

  it("accepts a genuine bathroom-tap article as HIGH", () => {
    const out = parseClassificationResponse(
      reply({
        classification: "HIGH",
        rejectionReason: null,
        matchedTopics: ["смесители и аксесоари за баня"],
        reason: "Монтаж на смесител за баня.",
      }),
      DOMESTICO
    );
    assert.ok(out.status === "ok");
    assert.equal(out.classification, "HIGH");
  });

  it("accepts a genuine ventilation article as MEDIUM", () => {
    const out = parseClassificationResponse(
      reply({
        classification: "MEDIUM",
        rejectionReason: null,
        matchedTopics: ["вентилация"],
        reason: "Как работи вентилацията в банята.",
      }),
      DOMESTICO
    );
    assert.ok(out.status === "ok");
    assert.equal(out.classification, "MEDIUM");
    assert.deepEqual(out.matchedTopics, ["вентилация"]);
  });

  it("accepts the trees article as OUT_OF_SCOPE — the verdict it should have had", () => {
    const out = parseClassificationResponse(
      reply({
        classification: "REJECTED",
        rejectionReason: "OUT_OF_SCOPE",
        matchedTopics: [],
        reason: "Статия за бързорастящи дървета; нито една конфигурирана тема не е за дървета.",
      }),
      DOMESTICO
    );
    assert.ok(out.status === "ok");
    assert.equal(out.classification, "REJECTED");
    assert.equal(out.rejectionReason, "OUT_OF_SCOPE");
    assert.deepEqual(out.matchedTopics, []);
  });

  it("refuses the trees article dressed up as HIGH on a broad category", () => {
    // The observed failure, in the shape the parser can see it: the model reaches
    // for a category name because no configured topic actually fits.
    const out = parseClassificationResponse(
      reply({
        classification: "HIGH",
        rejectionReason: null,
        matchedTopics: ["дървета"],
        reason: "Статия за бързорастящи дървета.",
      }),
      DOMESTICO
    );
    assert.equal(out.status, "invalid");
    assert.ok(out.status === "invalid");
    assert.match(out.feedback, /OUT_OF_SCOPE/);
  });

  it("refuses a generic home-improvement article matched on the industry", () => {
    for (const category of ["дом и градина", "ремонт", "home improvement"]) {
      const out = parseClassificationResponse(
        reply({
          classification: "HIGH",
          rejectionReason: null,
          matchedTopics: [category],
          reason: "Десет идеи за обновяване на дома.",
        }),
        DOMESTICO
      );
      assert.equal(out.status, "invalid", `expected "${category}" to be refused`);
    }
  });

  it("refuses broad-category similarity even when a real topic is cited too", () => {
    // "бои" alone would pass; the invented category alongside it is enough to send
    // the whole reply back, because it is evidence the match was made on the
    // category rather than on the topic.
    const out = parseClassificationResponse(
      reply({
        classification: "HIGH",
        rejectionReason: null,
        matchedTopics: ["бои", "градински продукти"],
        reason: "x",
      }),
      DOMESTICO
    );
    assert.equal(out.status, "invalid");
    assert.ok(out.status === "invalid");
    assert.match(out.problem, /градински продукти/);
  });

  it("refuses an invented topic on an OUT_OF_SCOPE reply too", () => {
    const out = parseClassificationResponse(
      reply({
        classification: "REJECTED",
        rejectionReason: "OUT_OF_SCOPE",
        matchedTopics: ["дървета"],
        reason: "x",
      }),
      DOMESTICO
    );
    assert.equal(out.status, "invalid");
    assert.ok(out.status === "invalid");
    assert.match(out.feedback, /leave "matchedTopics" empty/);
  });

  it("refuses an invented topic on a BLACKLIST reply too", () => {
    const out = parseClassificationResponse(
      reply({
        classification: "REJECTED",
        rejectionReason: "BLACKLIST",
        matchedTopics: ["отопление на дърва"],
        reason: "x",
      }),
      DOMESTICO
    );
    assert.equal(out.status, "invalid");
  });

  it("refuses OUT_OF_SCOPE that still names a topic the company asked for", () => {
    // Self-contradictory: either the article is about бои, or it is out of scope.
    for (const topic of ["бои", "вентилация"]) {
      const out = parseClassificationResponse(
        reply({
          classification: "REJECTED",
          rejectionReason: "OUT_OF_SCOPE",
          matchedTopics: [topic],
          reason: "x",
        }),
        DOMESTICO
      );
      assert.equal(out.status, "invalid", `expected OUT_OF_SCOPE + "${topic}" to be refused`);
    }
  });

  it("still allows OUT_OF_SCOPE to note an avoided topic it saw in passing", () => {
    const out = parseClassificationResponse(
      reply({
        classification: "REJECTED",
        rejectionReason: "OUT_OF_SCOPE",
        matchedTopics: ["камини"],
        reason: "x",
      }),
      DOMESTICO
    );
    assert.ok(out.status === "ok");
    assert.equal(out.rejectionReason, "OUT_OF_SCOPE");
  });

  it("carries the invented-topic correction into the repair call", () => {
    const bad = reply({
      classification: "HIGH",
      rejectionReason: null,
      matchedTopics: ["дървета"],
      reason: "x",
    });
    const out = parseClassificationResponse(bad, DOMESTICO);
    assert.ok(out.status === "invalid");

    const repair = buildClassificationRepairPrompt("<original>", bad, out.feedback);
    assert.match(repair, /<original>/);
    assert.match(repair, /дървета/);
    assert.match(repair, /VERBATIM/);
  });
});

describe("buildClassificationSystemPrompt — the strictness rule", () => {
  const scoped = buildClassificationSystemPrompt("scoped");

  it("says outright that industry relevance is not enough", () => {
    assert.match(scoped, /Industry relevance is not enough/);
    assert.match(scoped, /SUBSTANTIALLY about one of the configured topics/);
  });

  it("names the broad categories that must not count as a match", () => {
    for (const category of ["home improvement", "construction", "garden", "DIY"]) {
      assert.ok(scoped.includes(category), `expected the prompt to rule out "${category}"`);
    }
  });

  it("gives contrastive examples, including the trees case", () => {
    assert.match(scoped, /Worked examples/);
    assert.match(scoped, /trees/i);
    assert.match(scoped, /Industry proximity is not a match/);
    // And keeps the positive one, so strictness does not collapse into keyword
    // matching: latex still has to read as a paint.
    assert.match(scoped, /latex/i);
  });

  it("makes OUT_OF_SCOPE the default when no topic clearly fits", () => {
    assert.match(scoped, /DEFAULT answer/);
    assert.match(scoped, /Being unsure/);
  });

  it("keeps the semantic rule — a topic still need not appear as a word", () => {
    assert.match(scoped, /does not have to appear in the text/);
    assert.match(scoped, /Judge the meaning, never the spelling/);
  });

  it("drops the OUT_OF_SCOPE examples in blacklist-only mode but keeps the rule", () => {
    // Those examples all end in OUT_OF_SCOPE, which is not a verdict this mode
    // may return — so they would teach the wrong answer. The strictness rule
    // itself still applies, to the avoided list.
    const blacklistOnly = buildClassificationSystemPrompt("blacklist_only");
    assert.match(blacklistOnly, /Industry relevance is not enough/);
    assert.ok(!blacklistOnly.includes("Worked examples"));
    // OUT_OF_SCOPE survives only as the prohibition in the Verdicts section.
    assert.match(blacklistOnly, /do NOT use "OUT_OF_SCOPE"/);
  });
});
