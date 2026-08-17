import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CLASSIFICATION_ATTEMPTS,
  MAX_CLASSIFICATION_CONTENT_CHARS,
  MAX_STORED_REASON_CHARS,
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

  it("drops an invented topic rather than storing it as configuration", () => {
    const out = parseClassificationResponse(
      reply({
        classification: "HIGH",
        rejectionReason: null,
        matchedTopics: ["бои", "нещо измислено"],
        reason: "x",
      }),
      SCOPED
    );
    assert.ok(out.status === "ok");
    assert.deepEqual(out.matchedTopics, ["бои"]);
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
});
