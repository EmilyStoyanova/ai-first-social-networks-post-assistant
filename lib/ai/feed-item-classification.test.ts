import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CLASSIFICATION_ATTEMPTS,
  MAX_CLASSIFICATION_CONTENT_CHARS,
  MAX_COMPANY_CONTEXT_CHARS,
  MAX_STORED_MATCHED_TOPICS,
  MAX_STORED_REASON_CHARS,
  buildClassificationRepairPrompt,
  buildClassificationSystemPrompt,
  buildClassificationUserPrompt,
  classificationExcerpt,
  classificationFieldsForCreate,
  classificationFieldsForUpdate,
  classificationMode,
  classificationSelectableWhere,
  classifyInput,
  companyContextFingerprint,
  computeClassificationHash,
  hasCompanyContext,
  isClassifiableSourceType,
  parseClassificationResponse,
  topicsFingerprint,
  type ClassificationContext,
} from "./feed-item-classification";
import { resolveTopicPriorities, type TopicPriorities } from "./topic-priorities";

const SCOPED: TopicPriorities = resolveTopicPriorities({
  topPriorityTopics: ["бои", "бойлери"],
  mediumPriorityTopics: ["вентилация"],
  avoidedTopics: ["камини", "маси"],
});

const BLACKLIST_ONLY: TopicPriorities = resolveTopicPriorities({ avoidedTopics: ["камини"] });
const NONE: TopicPriorities = resolveTopicPriorities(null);

/**
 * A context with NO company copy — the neutral default, and the shape every test
 * that is not about company context should use.
 */
const ctx = (
  priorities: TopicPriorities,
  company: { description?: string | null; audience?: string | null } = {}
): ClassificationContext => ({
  priorities,
  companyDescription: company.description ?? null,
  targetAudience: company.audience ?? null,
});

/**
 * A model reply.
 *
 * `mainSubject` and `primaryTopic` are filled in with values that AGREE with the
 * rest of the object — the first matched topic, or null for OUT_OF_SCOPE — so a
 * test about (say) the rejection reason does not have to restate them. Pass either
 * explicitly, including null, to test it directly: the spread puts the caller last.
 */
const reply = (obj: Record<string, unknown>) =>
  JSON.stringify({
    mainSubject: "Какво разглежда статията.",
    primaryTopic:
      obj.rejectionReason === "OUT_OF_SCOPE"
        ? null
        : ((obj.matchedTopics as string[] | undefined)?.[0] ?? null),
    ...obj,
  });

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
    assert.equal(
      computeClassificationHash(text, ctx(SCOPED)),
      computeClassificationHash(text, ctx(SCOPED))
    );
  });

  it("changes when the article text changes", () => {
    assert.notEqual(
      computeClassificationHash(text, ctx(SCOPED)),
      computeClassificationHash({ ...text, body: "Друг текст." }, ctx(SCOPED))
    );
  });

  it("changes when the topic configuration changes", () => {
    const more = resolveTopicPriorities({
      topPriorityTopics: ["бои", "бойлери", "смесители"],
      mediumPriorityTopics: ["вентилация"],
      avoidedTopics: ["камини", "маси"],
    });
    assert.notEqual(
      computeClassificationHash(text, ctx(SCOPED)),
      computeClassificationHash(text, ctx(more))
    );
  });

  it("ignores text beyond the cap — what is not sent cannot change the answer", () => {
    const body = "b".repeat(MAX_CLASSIFICATION_CONTENT_CHARS);
    assert.equal(
      computeClassificationHash({ title: "t", body }, ctx(SCOPED)),
      computeClassificationHash({ title: "t", body: body + "ignored tail" }, ctx(SCOPED))
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

  /**
   * REGRESSION — the boundary that produced the permanently "Unclassified" rows.
   *
   * A row with NO status is deliberately not drained: the classification columns
   * shipped nullable and unbackfilled, so matching null here would silently spend
   * a model call on every legacy article of every company at once, without anyone
   * asking. Reopening those is `reclassifiableWhere`'s job — an explicit,
   * per-company, operator-triggered action.
   *
   * The two predicates are only safe as a pair: whatever this one refuses to
   * drain, that one must be able to reopen. Before the fix neither covered a null
   * status, and such a row was unreachable by every path in the system.
   */
  it("never drains a row that has no classification status at all", () => {
    const statuses = where.OR as Array<Record<string, unknown>>;
    const matchesNull = statuses.some((s) => s.classificationStatus === null);
    assert.equal(matchesNull, false);
    for (const s of statuses) {
      const list = (s.classificationStatus as { in?: unknown[] } | null)?.in;
      if (Array.isArray(list)) assert.equal(list.includes(null), false);
    }
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

// ─── The company context ──────────────────────────────────────────────────────
//
// The point of the context is to say what a bare topic word MEANS for this
// business, so "бои" is not read as whatever the article happens to suggest. The
// point of these tests is that it does nothing else — above all, that an empty
// context is exactly as if the feature did not exist.

const DESCRIPTION = "Доместико продава бои, бойлери и смесители за банята.";
const AUDIENCE = "Собственици на жилища в България, които ремонтират сами.";

describe("company context — the empty case is untouched", () => {
  it("has no context when both fields are blank, missing, or whitespace", () => {
    for (const company of [{}, { description: null, audience: null }, { description: "   " }]) {
      assert.equal(hasCompanyContext(ctx(SCOPED, company)), false);
    }
  });

  it("fingerprints to the empty string, so the hash is what it always was", () => {
    assert.equal(companyContextFingerprint(ctx(SCOPED)), "");
    assert.equal(companyContextFingerprint(ctx(SCOPED, { description: "  " })), "");
  });

  /**
   * THE backwards-compatibility test. A company that has never written brand copy
   * must keep the exact hash it had before this feature shipped — otherwise every
   * stored verdict silently becomes stale and the next reopen re-spends a model
   * call on all of them.
   */
  it("leaves the hash identical to a topics-only hash", () => {
    const text = { title: "Латекс за детска стая", body: "Как да изберем." };
    assert.equal(
      computeClassificationHash(text, ctx(SCOPED)),
      computeClassificationHash(text, ctx(SCOPED, { description: "", audience: "   " }))
    );
  });

  it("omits the section from the prompt entirely", () => {
    const prompt = buildClassificationUserPrompt({
      text: { title: "t", body: "b" },
      context: ctx(SCOPED),
      inputKind: "full",
    });
    assert.ok(!prompt.includes("## The company\n"));
    assert.ok(prompt.startsWith("## The company's topics"));
  });

  it("still applies the primaryTopic rules — they do not depend on the context", () => {
    const out = parseClassificationResponse(
      reply({
        classification: "HIGH",
        rejectionReason: null,
        primaryTopic: "вентилация",
        matchedTopics: ["вентилация", "бои"],
        reason: "x",
      }),
      SCOPED
    );
    assert.equal(out.status, "invalid");
  });
});

describe("company context — when it is configured", () => {
  const full = ctx(SCOPED, { description: DESCRIPTION, audience: AUDIENCE });

  it("is reported present and changes the hash", () => {
    assert.equal(hasCompanyContext(full), true);
    const text = { title: "t", body: "b" };
    assert.notEqual(
      computeClassificationHash(text, ctx(SCOPED)),
      computeClassificationHash(text, full)
    );
  });

  it("distinguishes the two fields — swapping them is a different context", () => {
    const swapped = ctx(SCOPED, { description: AUDIENCE, audience: DESCRIPTION });
    assert.notEqual(companyContextFingerprint(full), companyContextFingerprint(swapped));
  });

  it("renders both fields into the prompt, before the topics", () => {
    const prompt = buildClassificationUserPrompt({
      text: { title: "t", body: "b" },
      context: full,
      inputKind: "full",
    });
    assert.match(prompt, /## The company/);
    assert.ok(prompt.includes(DESCRIPTION));
    assert.ok(prompt.includes(`Audience: ${AUDIENCE}`));
    assert.ok(prompt.indexOf("## The company") < prompt.indexOf("## The company's topics"));
  });

  it("renders only the field that has content", () => {
    const prompt = buildClassificationUserPrompt({
      text: { title: "t", body: "b" },
      context: ctx(SCOPED, { description: DESCRIPTION }),
      inputKind: "full",
    });
    assert.ok(prompt.includes(DESCRIPTION));
    assert.ok(!prompt.includes("Audience:"));
  });

  /**
   * The constraint that makes the whole section safe. Brand copy is written to
   * sell the business, and a model handed one will read it as a licence to accept
   * anything adjacent unless it is told — in as many words — that the copy is not
   * a topic list. Asserted verbatim, because it is the sentence doing the work.
   */
  it("carries the sentence that stops the context from widening the scope", () => {
    const prompt = buildClassificationUserPrompt({
      text: { title: "t", body: "b" },
      context: full,
      inputKind: "full",
    });
    assert.ok(
      prompt.includes(
        "Company context only explains what the configured topics mean for this business. It MUST NOT create new eligible topics. If the article matches none of the configured topics, return OUT_OF_SCOPE even if it is generally relevant to the company's industry."
      )
    );
  });

  it("caps each field, so a pasted brochure cannot become a second topic list", () => {
    const long = "я".repeat(MAX_COMPANY_CONTEXT_CHARS + 500);
    const prompt = buildClassificationUserPrompt({
      text: { title: "t", body: "b" },
      context: ctx(SCOPED, { description: long, audience: long }),
      inputKind: "full",
    });
    assert.ok(!prompt.includes("я".repeat(MAX_COMPANY_CONTEXT_CHARS + 1)));
    assert.ok(prompt.includes("я".repeat(MAX_COMPANY_CONTEXT_CHARS)));
  });

  it("ignores text beyond the cap in the hash too", () => {
    const text = { title: "t", body: "b" };
    const at = "я".repeat(MAX_COMPANY_CONTEXT_CHARS);
    assert.equal(
      computeClassificationHash(text, ctx(SCOPED, { description: at })),
      computeClassificationHash(text, ctx(SCOPED, { description: at + " и още текст" }))
    );
  });
});

// ─── primaryTopic: the topic that decides the verdict ─────────────────────────
//
// The regression these guard: HIGH and MEDIUM were separable only by "does the
// reply cite ANY topic of that tier", which an article mainly about a medium
// topic satisfies the moment it mentions a top-priority one in passing. Naming
// the single dominant topic makes the tier check exact.
//
// As in the precision block above, what is asserted is which replies may be
// STORED. The semantic judgement itself is the model's, and is checked by hand.

describe("primaryTopic — the tier of the dominant topic decides", () => {
  const cases: Array<{ name: string; body: Record<string, unknown>; expect: "ok" | "invalid" }> = [
    {
      name: "a direct paint article is HIGH",
      body: {
        classification: "HIGH",
        rejectionReason: null,
        primaryTopic: "бои",
        matchedTopics: ["бои"],
        reason: "Лакове и импрегнатори за дърво.",
      },
      expect: "ok",
    },
    {
      name: "a direct boiler article is HIGH",
      body: {
        classification: "HIGH",
        rejectionReason: null,
        primaryTopic: "бойлери",
        matchedTopics: ["бойлери"],
        reason: "Как да обезкамените бойлер.",
      },
      expect: "ok",
    },
    {
      name: "a ventilation article is MEDIUM",
      body: {
        classification: "MEDIUM",
        rejectionReason: null,
        primaryTopic: "вентилация",
        matchedTopics: ["вентилация"],
        reason: "Вентилатор за таван.",
      },
      expect: "ok",
    },
    {
      name: "trees are OUT_OF_SCOPE with no primary topic",
      body: {
        classification: "REJECTED",
        rejectionReason: "OUT_OF_SCOPE",
        primaryTopic: null,
        matchedTopics: [],
        reason: "Бързорастящи дървета безплатно.",
      },
      expect: "ok",
    },
    {
      name: "household smells are OUT_OF_SCOPE",
      body: {
        classification: "REJECTED",
        rejectionReason: "OUT_OF_SCOPE",
        primaryTopic: null,
        matchedTopics: [],
        reason: "Как да премахнем миризмата в дома.",
      },
      expect: "ok",
    },
    {
      name: "generators are OUT_OF_SCOPE when no configured topic covers them",
      body: {
        classification: "REJECTED",
        rejectionReason: "OUT_OF_SCOPE",
        primaryTopic: null,
        matchedTopics: [],
        reason: "Генератори за ток при спиране на тока.",
      },
      expect: "ok",
    },
    {
      // THE regression. Mainly about ventilation, mentions paint in passing —
      // the old has("topPriorityTopics") test accepted this as HIGH.
      name: "a MEDIUM article that also mentions a TOP topic cannot be HIGH",
      body: {
        classification: "HIGH",
        rejectionReason: null,
        primaryTopic: "вентилация",
        matchedTopics: ["вентилация", "бои"],
        reason: "Монтаж на вентилатор, и с какво да боядисаме рамката после.",
      },
      expect: "invalid",
    },
    {
      name: "the same article is accepted as MEDIUM, still citing both topics",
      body: {
        classification: "MEDIUM",
        rejectionReason: null,
        primaryTopic: "вентилация",
        matchedTopics: ["вентилация", "бои"],
        reason: "Монтаж на вентилатор, и с какво да боядисаме рамката после.",
      },
      expect: "ok",
    },
    {
      name: "MEDIUM cannot rest on a TOP topic either — the mirror case",
      body: {
        classification: "MEDIUM",
        rejectionReason: null,
        primaryTopic: "бои",
        matchedTopics: ["бои"],
        reason: "x",
      },
      expect: "invalid",
    },
    {
      name: "an invented primary topic is refused",
      body: {
        classification: "HIGH",
        rejectionReason: null,
        primaryTopic: "дом и градина",
        matchedTopics: ["бои"],
        reason: "x",
      },
      expect: "invalid",
    },
    {
      name: "a primary topic missing from matchedTopics is refused",
      body: {
        classification: "HIGH",
        rejectionReason: null,
        primaryTopic: "бои",
        matchedTopics: ["бойлери"],
        reason: "x",
      },
      expect: "invalid",
    },
    {
      name: "OUT_OF_SCOPE with a primary topic contradicts itself",
      body: {
        classification: "REJECTED",
        rejectionReason: "OUT_OF_SCOPE",
        primaryTopic: "бои",
        matchedTopics: ["бои"],
        reason: "x",
      },
      expect: "invalid",
    },
    {
      name: "HIGH with no primary topic at all is refused",
      body: {
        classification: "HIGH",
        rejectionReason: null,
        primaryTopic: null,
        matchedTopics: ["бои"],
        reason: "x",
      },
      expect: "invalid",
    },
    {
      name: "BLACKLIST rests on an avoided topic",
      body: {
        classification: "REJECTED",
        rejectionReason: "BLACKLIST",
        primaryTopic: "камини",
        matchedTopics: ["камини"],
        reason: "Статия за камини.",
      },
      expect: "ok",
    },
    {
      name: "BLACKLIST cannot rest on a wanted topic",
      body: {
        classification: "REJECTED",
        rejectionReason: "BLACKLIST",
        primaryTopic: "бои",
        matchedTopics: ["бои", "камини"],
        reason: "x",
      },
      expect: "invalid",
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const out = parseClassificationResponse(reply(c.body), SCOPED);
      assert.equal(out.status, c.expect, `${c.name}: got ${JSON.stringify(out)}`);
    });
  }

  it("stores the primary topic in the company's spelling, not the model's", () => {
    const out = parseClassificationResponse(
      reply({
        classification: "HIGH",
        rejectionReason: null,
        primaryTopic: "БОИ",
        matchedTopics: ["БОИ"],
        reason: "x",
      }),
      SCOPED
    );
    assert.ok(out.status === "ok");
    assert.equal(out.primaryTopic, "бои");
  });

  it("names the invented primary topic in the repair feedback", () => {
    const out = parseClassificationResponse(
      reply({
        classification: "HIGH",
        rejectionReason: null,
        primaryTopic: "градински продукти",
        matchedTopics: ["бои"],
        reason: "x",
      }),
      SCOPED
    );
    assert.ok(out.status === "invalid");
    assert.match(out.problem, /градински продукти/);
    assert.match(out.feedback, /VERBATIM/);
  });

  it("requires a null primary topic for the neutral MEDIUM in blacklist-only mode", () => {
    const bare = parseClassificationResponse(
      reply({
        classification: "MEDIUM",
        rejectionReason: null,
        primaryTopic: null,
        matchedTopics: [],
        reason: "x",
      }),
      BLACKLIST_ONLY
    );
    assert.equal(bare.status, "ok");

    const cited = parseClassificationResponse(
      reply({
        classification: "MEDIUM",
        rejectionReason: null,
        primaryTopic: "камини",
        matchedTopics: ["камини"],
        reason: "x",
      }),
      BLACKLIST_ONLY
    );
    assert.equal(cited.status, "invalid");
  });
});

describe("mainSubject — what the article is about", () => {
  it("is required: a verdict that cannot name the subject did not read the article", () => {
    const out = parseClassificationResponse(
      JSON.stringify({
        primaryTopic: "бои",
        classification: "HIGH",
        rejectionReason: null,
        matchedTopics: ["бои"],
        reason: "x",
      }),
      SCOPED
    );
    assert.equal(out.status, "invalid");
    assert.ok(out.status === "invalid");
    assert.match(out.feedback, /mainSubject/);
  });

  it("is capped like the reason", () => {
    const out = parseClassificationResponse(
      reply({
        mainSubject: "я".repeat(MAX_STORED_REASON_CHARS + 200),
        classification: "HIGH",
        rejectionReason: null,
        primaryTopic: "бои",
        matchedTopics: ["бои"],
        reason: "x",
      }),
      SCOPED
    );
    assert.ok(out.status === "ok");
    assert.equal(out.mainSubject.length, MAX_STORED_REASON_CHARS);
  });

  it("is asked for as a description, never as reasoning", () => {
    // A model told to "explain your thinking" writes an argument here, and the
    // field stops being usable as a diagnostic — the whole reason it exists.
    const prompt = buildClassificationSystemPrompt("scoped");
    assert.match(prompt, /short, factual description of the subject itself/);
    assert.match(prompt, /not an argument for your verdict/);
  });
});

describe("buildClassificationSystemPrompt — HIGH vs MEDIUM", () => {
  const scoped = buildClassificationSystemPrompt("scoped");

  it("states that a passing mention never promotes an article", () => {
    assert.match(scoped, /A passing mention never promotes it/);
    assert.match(scoped, /stays MEDIUM even when it also mentions a TOP PRIORITY topic/);
  });

  it("makes the single dominant topic the deciding one", () => {
    assert.match(scoped, /which SINGLE configured topic the article is mainly about/);
    assert.match(scoped, /the list it belongs to decides the verdict/);
  });

  it("keeps BLACKLIST as a main-subject-only override", () => {
    assert.match(scoped, /ONLY when an avoided topic is itself a main subject/);
  });

  it("shows the demotion case among the worked examples", () => {
    assert.match(scoped, /must not raise this to HIGH/);
  });

  it("asks for a null primaryTopic in blacklist-only mode, where nothing is wanted", () => {
    const blacklistOnly = buildClassificationSystemPrompt("blacklist_only");
    assert.match(blacklistOnly, /"primaryTopic": null/);
    assert.ok(!blacklistOnly.includes("SINGLE configured topic"));
  });
});
