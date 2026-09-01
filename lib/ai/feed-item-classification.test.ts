import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  CLASSIFICATION_SEMANTIC_VERSION,
  MAX_CLASSIFICATION_ATTEMPTS,
  MAX_CLASSIFICATION_CONTENT_CHARS,
  MAX_COMPANY_CONTEXT_CHARS,
  MAX_STORED_MATCHED_TOPICS,
  MAX_STORED_REASON_CHARS,
  MIN_UNDERSTANDING_CONFIDENCE_FOR_HIGH,
  buildClassificationRepairPrompt,
  buildClassificationSystemPrompt,
  buildClassificationUserPrompt,
  fitsSingleClassificationCall,
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
import type { ArticleUnderstanding } from "./article-understanding";
import { resolveTopicPriorities, type TopicPriorities } from "./topic-priorities";
import { resolveFeedItemContent } from "./feed-item-translation";

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
 * `primaryTopic` is filled in with a value that AGREES with the rest of the
 * object — the first matched topic, or null for OUT_OF_SCOPE — so a test about
 * (say) the rejection reason does not have to restate it. Pass it explicitly,
 * including null, to test it directly: the spread puts the caller last.
 *
 * No `mainSubject` here — the verdict reply no longer carries one. See
 * `ClassificationVerdict`'s own comment: it comes exclusively from
 * `ArticleUnderstanding`, produced upstream by `understandArticle`.
 */
const reply = (obj: Record<string, unknown>) =>
  JSON.stringify({
    primaryTopic:
      obj.rejectionReason === "OUT_OF_SCOPE"
        ? null
        : ((obj.matchedTopics as string[] | undefined)?.[0] ?? null),
    ...obj,
  });

/**
 * An `ArticleUnderstanding` — the article representation `buildClassificationUserPrompt`
 * is judged from. Confidence defaults comfortably above
 * {@link MIN_UNDERSTANDING_CONFIDENCE_FOR_HIGH}, so a test unrelated to the
 * confidence gate does not have to restate it.
 */
const understanding = (overrides: Partial<ArticleUnderstanding> = {}): ArticleUnderstanding => ({
  mainSubject: "Какво разглежда статията.",
  centralThesis: null,
  centralConflict: null,
  articleType: "news",
  secondaryTopics: [],
  incidentalTopics: [],
  entities: [],
  confidence: 0.9,
  evidence: [{ chunkIndex: 0, reason: "states the subject directly" }],
  ...overrides,
});

describe("isClassifiableSourceType", () => {
  it("covers article feeds only", () => {
    assert.equal(isClassifiableSourceType("rss"), true);
    for (const type of ["prompt", "product_page", "calendar_event"]) {
      assert.equal(isClassifiableSourceType(type), false);
    }
  });

  // Part 3B §4/§25.7 — competitor content never enters the normal
  // classification queue, whatever else changes about that pipeline.
  it("rejects both competitor source types", () => {
    assert.equal(isClassifiableSourceType("competitor_rss"), false);
    assert.equal(isClassifiableSourceType("competitor_website"), false);
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

describe("classifyInput / fitsSingleClassificationCall", () => {
  it("classifies what the stored text can support", () => {
    assert.equal(classifyInput({ title: "t", body: "b" }), "full");
    assert.equal(classifyInput({ title: "t", body: "   " }), "title_only");
    assert.equal(classifyInput({ title: null, body: null }), "empty");
  });

  it("a short body fits one call", () => {
    assert.equal(fitsSingleClassificationCall("A short article body."), true);
  });

  it("a long body does not fit one call — understandArticle routes it through chunking instead", () => {
    // This module no longer builds a prompt from raw text at all — see
    // `ClassificationPromptInput`'s own comment. fitsSingleClassificationCall
    // survives only because `understandArticle` reuses it for the identical
    // decision one step upstream, and `classify-feed-item.service.ts` reuses
    // it again to size an item's timeout budget.
    const long = "a".repeat(MAX_CLASSIFICATION_CONTENT_CHARS + 500);
    assert.equal(fitsSingleClassificationCall(long), false);
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

  it("changes when text past the OLD naive cutoff changes — the excerpt now reads it", () => {
    // Before this fix, classificationExcerpt was a blind slice(0, cap), so two
    // articles differing only after the cap hashed identically — a re-ingest
    // that changed only an article's ending would settle back to `completed`
    // without ever re-judging it. The beginning/middle/end excerpt reads past
    // the old cutoff, so this must no longer hold.
    const base = "b".repeat(MAX_CLASSIFICATION_CONTENT_CHARS);
    assert.notEqual(
      computeClassificationHash({ title: "t", body: `${base} MARKER_ONE` }, ctx(SCOPED)),
      computeClassificationHash({ title: "t", body: `${base} MARKER_TWO` }, ctx(SCOPED))
    );
  });

  // ── The classifier's own semantics are part of the identity ───────────────
  //
  // Without this, a corrected classifier could never reach an already-classified
  // article: reopening it recomputes the hash, finds it unchanged, and settles
  // the row straight back to `completed` carrying the OLD verdict and spending
  // no model call. The fix would look deployed and change nothing.

  it("participates in the hash, so a semantics change makes stored verdicts stale", () => {
    // Recomputed the way `computeClassificationHash` does, but at the PREVIOUS
    // version — proving the constant is genuinely part of the digest rather than
    // merely exported beside it.
    const atVersion = (version: number) =>
      createHash("sha256")
        .update(
          [
            text.title,
            text.body,
            topicsFingerprint(SCOPED),
            companyContextFingerprint(ctx(SCOPED)),
            String(version),
          ].join("")
        )
        .digest("hex");

    assert.equal(
      computeClassificationHash(text, ctx(SCOPED)),
      atVersion(CLASSIFICATION_SEMANTIC_VERSION)
    );
    assert.notEqual(
      computeClassificationHash(text, ctx(SCOPED)),
      atVersion(CLASSIFICATION_SEMANTIC_VERSION - 1)
    );
  });

  /**
   * Idempotency, which is what stops a version bump from becoming a permanent
   * reclassification loop: the version is a CONSTANT, so once a row has been
   * re-judged and stored the new hash, every later reopen settles it for free
   * again. Two runs at the same version must agree exactly.
   */
  it("is unchanged between runs at the same semantic version", () => {
    assert.equal(
      computeClassificationHash(text, ctx(SCOPED)),
      computeClassificationHash(text, ctx(SCOPED))
    );
    assert.equal(typeof CLASSIFICATION_SEMANTIC_VERSION, "number");
  });
});

// ─── Article understanding, consumed not re-derived ────────────────────────────
//
// The bug this architecture exists to fix, in two parts. First: classification
// used to be handed a blind slice(0, MAX_CLASSIFICATION_CONTENT_CHARS) of the
// article body (and, briefly, a beginning/middle/end sample of it) — a real
// subject stated only in the middle or the end could be discarded before the
// model ever saw it. Second, even after a whole-article synthesis fixed that:
// the SAME call that read the article also decided the verdict, so naming the
// subject and matching it against a topic were never really separate questions.
//
// Both are now `understandArticle`'s job, entirely upstream (see
// `article-understanding.ts` and `understand-article.service.ts`, and their own
// test suites for the chunking/reduction/confidence machinery). This module
// receives the finished `ArticleUnderstanding` and does nothing but render it
// and match it against topics — these tests exercise exactly that rendering.

describe("buildClassificationUserPrompt — the article understanding section", () => {
  it("renders every field, in order, under its own heading", () => {
    const u = understanding({
      mainSubject: "Residents are protesting a new coastal tourism development.",
      centralThesis: "Development threatens local residents' access to the shore.",
      centralConflict: "Residents versus developers.",
      articleType: "news",
      secondaryTopics: ["protected coastal area"],
      incidentalTopics: ["tourism", "beaches", "hotels"],
      entities: ["Albania"],
      confidence: 0.75,
      evidence: [{ chunkIndex: 9, reason: "names the protest directly" }],
    });
    const prompt = buildClassificationUserPrompt({ understanding: u, context: ctx(SCOPED) });

    assert.match(prompt, /## Article understanding/);
    const order = [
      "MAIN SUBJECT:",
      "Residents are protesting a new coastal tourism development.",
      "CENTRAL THESIS:",
      "Development threatens local residents' access to the shore.",
      "CENTRAL CONFLICT:",
      "Residents versus developers.",
      "ARTICLE TYPE:",
      "news",
      "SECONDARY TOPICS:",
      "protected coastal area",
      "INCIDENTAL TOPICS:",
      "tourism, beaches, hotels",
      "ENTITIES:",
      "Albania",
      "UNDERSTANDING CONFIDENCE:",
      "0.75",
      "EVIDENCE:",
      "[section 9] names the protest directly",
    ];
    let cursor = -1;
    for (const token of order) {
      const idx = prompt.indexOf(token);
      assert.ok(idx !== -1, `expected to find ${JSON.stringify(token)}`);
      assert.ok(
        idx > cursor,
        `expected ${JSON.stringify(token)} to appear after the previous field`
      );
      cursor = idx;
    }
  });

  it("renders (none) for a null thesis/conflict and empty topic/entity lists — the heading is never dropped", () => {
    const u = understanding({
      centralThesis: null,
      centralConflict: null,
      secondaryTopics: [],
      incidentalTopics: [],
      entities: [],
    });
    const prompt = buildClassificationUserPrompt({ understanding: u, context: ctx(SCOPED) });
    assert.match(prompt, /CENTRAL THESIS:\n\(none/);
    assert.match(prompt, /CENTRAL CONFLICT:\n\(none\)/);
    assert.match(prompt, /SECONDARY TOPICS:\n\(none\)/);
    assert.match(prompt, /INCIDENTAL TOPICS:\n\(none\)/);
    assert.match(prompt, /ENTITIES:\n\(none\)/);
  });

  it("appears before the company's configured topic lists", () => {
    const prompt = buildClassificationUserPrompt({
      understanding: understanding(),
      context: ctx(SCOPED),
    });
    assert.ok(
      prompt.indexOf("## Article understanding") < prompt.indexOf("## The company's topics")
    );
  });

  it("the Albania case: incidental tourism topics are shown separately from the real (protest) subject", () => {
    const u = understanding({
      mainSubject: "Residents are protesting new tourism development in a protected coastal area.",
      incidentalTopics: ["tourism", "beaches", "hotels", "scenery"],
    });
    const prompt = buildClassificationUserPrompt({ understanding: u, context: ctx(SCOPED) });
    const mainSubjectLine = prompt.slice(
      prompt.indexOf("MAIN SUBJECT:"),
      prompt.indexOf("CENTRAL THESIS:")
    );
    assert.match(mainSubjectLine, /protesting new tourism development/);
    assert.doesNotMatch(mainSubjectLine, /beaches|hotels|scenery/);
    assert.match(prompt, /INCIDENTAL TOPICS:\ntourism, beaches, hotels, scenery/);
  });

  it("stays bounded however many topics, entities, or evidence entries the understanding carries", () => {
    // ArticleUnderstanding's own caps (MAX_SECONDARY_TOPICS, MAX_EVIDENCE, ...)
    // already bound this — this proves the PROMPT built from it inherits that
    // bound rather than re-expanding it.
    const u = understanding({
      secondaryTopics: Array.from({ length: 8 }, (_, i) => `topic ${i}`),
      incidentalTopics: Array.from({ length: 8 }, (_, i) => `incidental ${i}`),
      entities: Array.from({ length: 12 }, (_, i) => `entity ${i}`),
      evidence: Array.from({ length: 6 }, (_, i) => ({ chunkIndex: i, reason: `reason ${i}` })),
    });
    const prompt = buildClassificationUserPrompt({ understanding: u, context: ctx(SCOPED) });
    assert.ok(prompt.length < 4000, `expected a bounded prompt, got ${prompt.length} chars`);
  });

  it("tells the model to trust the understanding rather than re-deriving the subject", () => {
    const prompt = buildClassificationUserPrompt({
      understanding: understanding(),
      context: ctx(SCOPED),
    });
    assert.match(prompt, /do not (re-derive|substitute) the subject/i);
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

// ─── Cross-lingual matching ──────────────────────────────────────────────────
//
// The production failure: an English article understanding judged against a
// Bulgarian topic list came back OUT_OF_SCOPE with no matched topics, because
// nothing in the rulebook said that a topic in another language is still the
// same subject — and the rulebook's DEFAULT answer is rejection. The fix is
// additive: it names the language difference as a non-reason, and leaves every
// precision rule exactly where it was.

describe("buildClassificationSystemPrompt — cross-lingual matching", () => {
  const scoped = buildClassificationSystemPrompt("scoped");

  it("says a different language or script is never itself a reason to reject", () => {
    assert.match(scoped, /DIFFERENT LANGUAGES or different scripts/);
    assert.match(scoped, /NEVER, on its own, a reason to reject/);
    assert.match(
      scoped,
      /Not recognising a word is not the same as the article being out of scope/
    );
  });

  it("keeps the semantic categories when crossing a language", () => {
    assert.match(scoped, /translation, a synonym of that translation, a specific kind of it/);
    assert.match(scoped, /direct choice, use, installation, repair or care/);
  });

  it("demands the configured topic be written back verbatim, never translated", () => {
    assert.match(scoped, /EXACTLY as it appears in the lists below/);
    assert.match(scoped, /never translate it, transliterate it, re-spell it/);
  });

  it("carries a positive cross-lingual worked example", () => {
    assert.match(scoped, /choosing paint colours and paint finishes for a bedroom/);
    assert.match(scoped, /primaryTopic "бои", HIGH, matchedTopics \["бои"\]/);
    // And spells out that the answer keeps the configured spelling.
    assert.match(scoped, /"бои", not "paints" and not "boi"/);
  });

  /**
   * The counterweight, and the reason this is not just a loosening. The same
   * Bulgarian topic against a merely-adjacent English article must still be
   * OUT_OF_SCOPE — otherwise "cross-lingual" would have become a licence to
   * match anything in the neighbourhood.
   */
  it("carries a negative cross-lingual worked example that stays OUT_OF_SCOPE", () => {
    assert.match(scoped, /how a room's orientation changes the amount of natural daylight/);
    assert.match(scoped, /Crossing a language barrier never lowers the bar/);
  });

  it("states outright that the cross-lingual rule does not weaken the strictness rule", () => {
    assert.match(scoped, /rule 4 never weakens rule 5/);
    assert.match(scoped, /still OUT_OF_SCOPE, exactly as a same-language one would be/);
  });

  /** Precision is preserved, not traded away — the pre-existing rules survive verbatim. */
  it("keeps every strictness rule it had before", () => {
    assert.match(scoped, /Industry relevance is not enough/);
    assert.match(scoped, /SUBSTANTIALLY about one of the configured topics/);
    assert.match(scoped, /DEFAULT answer/);
    assert.match(scoped, /Industry proximity is not a match/);
    for (const category of ["home improvement", "construction", "garden", "DIY"]) {
      assert.ok(scoped.includes(category), `expected the prompt to still rule out "${category}"`);
    }
  });

  it("carries the cross-lingual rule in blacklist-only mode too, without the examples", () => {
    const blacklistOnly = buildClassificationSystemPrompt("blacklist_only");
    assert.match(blacklistOnly, /DIFFERENT LANGUAGES or different scripts/);
    assert.ok(!blacklistOnly.includes("Worked examples"));
  });
});

describe("cross-lingual verdicts — the exact configured spelling survives", () => {
  /**
   * An English article understanding, a Bulgarian topic list, one prompt. This is
   * the shape every Domestico classification actually has, and the prompt has to
   * carry both halves intact for the model to have any chance of matching them.
   */
  it("renders an English understanding beside the Bulgarian topic lists", () => {
    const prompt = buildClassificationUserPrompt({
      understanding: understanding({
        mainSubject: "Choosing paint colours and paint finishes for a bedroom",
        secondaryTopics: ["colour psychology"],
      }),
      context: ctx(SCOPED),
    });
    assert.match(prompt, /Choosing paint colours and paint finishes for a bedroom/);
    assert.match(prompt, /- бои/);
    assert.match(prompt, /- вентилация/);
  });

  it("accepts a HIGH built on a Bulgarian topic from an English subject", () => {
    const out = parseClassificationResponse(
      reply({
        classification: "HIGH",
        rejectionReason: null,
        matchedTopics: ["бои"],
        reason: "The main subject is choosing paint, which is what бои means.",
      }),
      SCOPED
    );
    assert.equal(out.status, "ok");
    if (out.status === "ok") {
      // The stored spelling, byte for byte — not a translation of it.
      assert.equal(out.primaryTopic, "бои");
      assert.deepEqual(out.matchedTopics, ["бои"]);
    }
  });

  /**
   * The model answering in the ARTICLE's language instead of copying the topic
   * is the failure mode the verbatim rule exists to prevent. It must be refused
   * rather than quietly resolved, because "paints" is not a configured topic and
   * a verdict resting on it rests on nothing.
   */
  it("refuses a verdict that translated the topic into the article's language", () => {
    const out = parseClassificationResponse(
      reply({
        classification: "HIGH",
        rejectionReason: null,
        matchedTopics: ["paints"],
        reason: "The article is about paints.",
      }),
      SCOPED
    );
    assert.equal(out.status, "invalid");
    if (out.status === "invalid") assert.match(out.feedback, /VERBATIM/);
  });

  it("keeps a merely-adjacent English article OUT_OF_SCOPE against Bulgarian topics", () => {
    const out = parseClassificationResponse(
      reply({
        classification: "REJECTED",
        rejectionReason: "OUT_OF_SCOPE",
        matchedTopics: [],
        reason: "Room orientation and daylight are not any configured topic.",
      }),
      SCOPED
    );
    assert.equal(out.status, "ok");
    if (out.status === "ok") {
      assert.equal(out.classification, "REJECTED");
      assert.equal(out.rejectionReason, "OUT_OF_SCOPE");
      assert.equal(out.primaryTopic, null);
      assert.deepEqual(out.matchedTopics, []);
    }
  });

  it("matches a MEDIUM topic across languages, with its spelling intact", () => {
    const out = parseClassificationResponse(
      reply({
        classification: "MEDIUM",
        rejectionReason: null,
        matchedTopics: ["вентилация"],
        reason: "The subject is home ventilation.",
      }),
      SCOPED
    );
    assert.equal(out.status, "ok");
    if (out.status === "ok") {
      assert.equal(out.classification, "MEDIUM");
      assert.equal(out.primaryTopic, "вентилация");
    }
  });

  /** BLACKLIST semantics are untouched by any of this. */
  it("still blacklists an English article that IS about an avoided Bulgarian topic", () => {
    const out = parseClassificationResponse(
      reply({
        classification: "REJECTED",
        rejectionReason: "BLACKLIST",
        matchedTopics: ["камини"],
        reason: "The article is about choosing a fireplace.",
      }),
      SCOPED
    );
    assert.equal(out.status, "ok");
    if (out.status === "ok") {
      assert.equal(out.rejectionReason, "BLACKLIST");
      assert.equal(out.primaryTopic, "камини");
    }
  });

  it("still refuses BLACKLIST that cites no avoided topic, cross-lingual or not", () => {
    const out = parseClassificationResponse(
      reply({
        classification: "REJECTED",
        rejectionReason: "BLACKLIST",
        primaryTopic: null,
        matchedTopics: [],
        reason: "Felt wrong.",
      }),
      SCOPED
    );
    assert.equal(out.status, "invalid");
  });
});

describe("untranslated articles are judged deliberately, not accidentally", () => {
  /**
   * `resolveFeedItemContent` falls back to the ORIGINAL text whenever the
   * translation has not completed — so a pending or failed translation is
   * exactly how an English article reaches a Bulgarian topic list. That is a
   * deliberate design decision (a verdict on the real article beats no verdict),
   * and it is the reason the cross-lingual rule above has to exist at all rather
   * than being a case that "cannot happen".
   */
  for (const translationStatus of ["pending", "failed", "translating", null]) {
    it(`uses the original English text when translation is ${translationStatus ?? "absent"}`, () => {
      const resolved = resolveFeedItemContent({
        title: "Choosing paint colours for a bedroom",
        content: "Which finish suits a north-facing room.",
        translatedTitle: null,
        translatedContent: null,
        translationStatus,
      });
      assert.equal(resolved.usedTranslation, false);
      assert.equal(resolved.title, "Choosing paint colours for a bedroom");
    });
  }

  it("prefers the Bulgarian translation once it has completed", () => {
    const resolved = resolveFeedItemContent({
      title: "Choosing paint colours for a bedroom",
      content: "Which finish suits a north-facing room.",
      translatedTitle: "Избор на цвят боя за спалня",
      translatedContent: "Кой финиш е подходящ за стая на север.",
      translationStatus: "completed",
    });
    assert.equal(resolved.usedTranslation, true);
    assert.equal(resolved.title, "Избор на цвят боя за спалня");
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
      understanding: understanding(),
      context: ctx(SCOPED),
    });
    assert.ok(!prompt.includes("## The company\n"));
    // No company section: the prompt opens straight on the article
    // understanding, exactly as it would with company copy trimmed to nothing.
    assert.ok(prompt.trimStart().startsWith("## Article understanding"));
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
      understanding: understanding(),
      context: full,
    });
    assert.match(prompt, /## The company/);
    assert.ok(prompt.includes(DESCRIPTION));
    assert.ok(prompt.includes(`Audience: ${AUDIENCE}`));
    assert.ok(prompt.indexOf("## The company") < prompt.indexOf("## The company's topics"));
  });

  it("renders only the field that has content", () => {
    const prompt = buildClassificationUserPrompt({
      understanding: understanding(),
      context: ctx(SCOPED, { description: DESCRIPTION }),
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
      understanding: understanding(),
      context: full,
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
      understanding: understanding(),
      context: ctx(SCOPED, { description: long, audience: long }),
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

describe("mainSubject — no longer part of the verdict reply", () => {
  it("a reply is accepted with no mainSubject field at all — it is not asked for here", () => {
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
    assert.equal(out.status, "ok");
  });

  it("a mainSubject field in the reply, if a model adds one anyway, is ignored — the stored value can only come from ArticleUnderstanding", () => {
    const out = parseClassificationResponse(
      reply({
        mainSubject: "A DIFFERENT subject the verdict model invented.",
        classification: "HIGH",
        rejectionReason: null,
        primaryTopic: "бои",
        matchedTopics: ["бои"],
        reason: "x",
      }),
      SCOPED
    );
    assert.ok(out.status === "ok");
    assert.ok(
      !("mainSubject" in out),
      "ClassificationVerdict must not carry a mainSubject the caller could mistakenly store"
    );
  });

  it("the system prompt tells the model to trust the given understanding, not restate or replace it", () => {
    const prompt = buildClassificationSystemPrompt("scoped");
    assert.match(prompt, /Treat it as fact/);
    assert.match(prompt, /Do NOT re-read, re-summarize, restate in different words, or replace it/);
  });

  it("the JSON answer contract no longer asks for mainSubject", () => {
    for (const mode of ["scoped", "blacklist_only"] as const) {
      const prompt = buildClassificationSystemPrompt(mode);
      const answerSection = prompt.slice(prompt.indexOf("## Answer"));
      assert.ok(!answerSection.includes('"mainSubject"'));
    }
  });
});

describe("HIGH requires a confident understanding (MIN_UNDERSTANDING_CONFIDENCE_FOR_HIGH)", () => {
  const highReply = reply({
    classification: "HIGH",
    rejectionReason: null,
    primaryTopic: "бои",
    matchedTopics: ["бои"],
    reason: "Article about choosing paint.",
  });

  it("refuses HIGH when the understanding confidence is below the threshold", () => {
    const out = parseClassificationResponse(
      highReply,
      SCOPED,
      MIN_UNDERSTANDING_CONFIDENCE_FOR_HIGH - 0.01
    );
    assert.equal(out.status, "invalid");
    assert.ok(out.status === "invalid");
    assert.match(out.feedback, /UNDERSTANDING CONFIDENCE/);
  });

  it("accepts HIGH exactly at the threshold", () => {
    const out = parseClassificationResponse(
      highReply,
      SCOPED,
      MIN_UNDERSTANDING_CONFIDENCE_FOR_HIGH
    );
    assert.equal(out.status, "ok");
  });

  it("accepts HIGH comfortably above the threshold", () => {
    const out = parseClassificationResponse(highReply, SCOPED, 0.9);
    assert.equal(out.status, "ok");
  });

  it("does NOT gate MEDIUM on low confidence — only HIGH is treated as aggressive", () => {
    const mediumReply = reply({
      classification: "MEDIUM",
      rejectionReason: null,
      primaryTopic: "вентилация",
      matchedTopics: ["вентилация"],
      reason: "x",
    });
    const out = parseClassificationResponse(mediumReply, SCOPED, 0.05);
    assert.equal(out.status, "ok");
  });

  it("does NOT gate OUT_OF_SCOPE or BLACKLIST on low confidence", () => {
    const outOfScope = reply({
      classification: "REJECTED",
      rejectionReason: "OUT_OF_SCOPE",
      primaryTopic: null,
      matchedTopics: [],
      reason: "x",
    });
    const blacklist = reply({
      classification: "REJECTED",
      rejectionReason: "BLACKLIST",
      primaryTopic: "камини",
      matchedTopics: ["камини"],
      reason: "x",
    });
    assert.equal(parseClassificationResponse(outOfScope, SCOPED, 0.05).status, "ok");
    assert.equal(parseClassificationResponse(blacklist, SCOPED, 0.05).status, "ok");
  });

  it("the system prompt visibly tells the model to hold back HIGH on low confidence", () => {
    const prompt = buildClassificationSystemPrompt("scoped");
    assert.match(prompt, /UNDERSTANDING CONFIDENCE.*is low/i);
    assert.match(prompt, /Do not answer HIGH/);
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
