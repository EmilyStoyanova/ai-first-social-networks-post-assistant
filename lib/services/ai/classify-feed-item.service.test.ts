import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyFeedItem,
  type ClassifiableItem,
  type ClassifyFeedItemDeps,
} from "./classify-feed-item.service";
import {
  computeClassificationHash,
  type ClassificationContext,
} from "@/lib/ai/feed-item-classification";
import {
  planClassificationChunks,
  type ChunkAnalysis,
} from "@/lib/ai/classification-chunk-analysis";
import { resolveTopicPriorities } from "@/lib/ai/topic-priorities";

const NOW = new Date("2026-08-17T12:00:00Z");

/** Topics only, no brand copy — the neutral context most of these tests want. */
const SCOPED: ClassificationContext = {
  priorities: resolveTopicPriorities({
    topPriorityTopics: ["бои"],
    mediumPriorityTopics: ["вентилация"],
    avoidedTopics: ["камини"],
  }),
  companyDescription: null,
  targetAudience: null,
};
const NONE: ClassificationContext = {
  priorities: resolveTopicPriorities(null),
  companyDescription: null,
  targetAudience: null,
};

const DESCRIPTION = "Доместико продава бои, бойлери и смесители за банята.";
const AUDIENCE = "Собственици на жилища, които ремонтират сами.";

/** The same topics, with the brand copy filled in. */
const SCOPED_WITH_CONTEXT: ClassificationContext = {
  ...SCOPED,
  companyDescription: DESCRIPTION,
  targetAudience: AUDIENCE,
};

function item(overrides: Partial<ClassifiableItem> = {}): ClassifiableItem {
  return {
    id: "item-1",
    title: "Как да изберем латекс",
    content: "Дълъг текст за боядисване на стени.",
    url: "https://example.com/a",
    translationStatus: null,
    classificationStatus: "pending",
    classificationHash: null,
    classificationAttemptCount: 0,
    ...overrides,
  };
}

interface Recorded {
  updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
  updateManys: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
  prompts: string[];
}

/**
 * A db double plus a provider double. `claimWins`/`writeWins` control the two
 * conditional writes independently, which is how the lease races are exercised
 * without a database. The SAME provider instance is threaded through both
 * `understandArticle` and the verdict call — exactly as production does — so
 * `replies` is one queue every model call (understanding, chunk analyses, the
 * synthesis, the verdict) draws from in call order.
 */
function makeDeps(opts: {
  replies?: string[];
  throwOnGenerate?: Error;
  /** Throws `throwOnGenerate` (or a default error) on exactly the Nth `generate` call (0-indexed), not every call. */
  throwOnCallIndex?: number;
  noProvider?: boolean;
  claimWins?: boolean;
  writeWins?: boolean;
}): { deps: ClassifyFeedItemDeps; rec: Recorded } {
  const rec: Recorded = { updates: [], updateManys: [], prompts: [] };
  const replies = [...(opts.replies ?? [])];
  let updateManyCall = 0;
  let generateCall = 0;

  const deps: ClassifyFeedItemDeps = {
    now: () => NOW,
    attemptTimeoutMs: 1000,
    itemTimeoutMs: 5000,
    db: {
      feedItem: {
        update: async (args) => {
          rec.updates.push(args as never);
          return {};
        },
        updateMany: async (args) => {
          rec.updateManys.push(args as never);
          updateManyCall += 1;
          // First updateMany is the claim; any later one is the settle/fail write.
          const wins = updateManyCall === 1 ? (opts.claimWins ?? true) : (opts.writeWins ?? true);
          return { count: wins ? 1 : 0 };
        },
      },
    },
    resolveProvider: async () =>
      opts.noProvider
        ? { ok: false }
        : {
            ok: true,
            provider: "TEXT_WORKER",
            model: "qwen",
            instance: {
              generate: async (req) => {
                rec.prompts.push(req.userPrompt);
                const callIndex = generateCall++;
                if (opts.throwOnCallIndex !== undefined) {
                  if (callIndex === opts.throwOnCallIndex) {
                    throw opts.throwOnGenerate ?? new Error("simulated transport failure");
                  }
                } else if (opts.throwOnGenerate) {
                  throw opts.throwOnGenerate;
                }
                return { text: replies.shift() ?? "" };
              },
            },
          },
  };

  return { deps, rec };
}

/** A well-formed chunk-analysis reply — see `classification-chunk-analysis.ts`. */
function chunkReply(overrides: Partial<ChunkAnalysis> = {}): string {
  return JSON.stringify({
    mainPoint: "A section of the article.",
    topics: [],
    entities: [],
    importantFacts: [],
    centrality: "supporting",
    ...overrides,
  });
}

/** A well-formed `ArticleUnderstanding` reply — see `article-understanding.ts`. */
function understandingReply(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    mainSubject: "Избор на латекс за стени.",
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
}

/** A well-formed VERDICT reply — no `mainSubject`; that comes from `understandingReply` alone. */
function verdictReply(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    primaryTopic: "бои",
    classification: "HIGH",
    rejectionReason: null,
    matchedTopics: ["бои"],
    reason: "About choosing paint.",
    ...overrides,
  });
}

// ─── Backwards compatibility ──────────────────────────────────────────────────

describe("classifyFeedItem — no topic configuration", () => {
  it("skips without a model call and stores NO verdict", async () => {
    const { deps, rec } = makeDeps({});
    const out = await classifyFeedItem(item(), NONE, deps);

    assert.deepEqual(out, { status: "skipped", reason: "not_configured" });
    assert.equal(rec.prompts.length, 0, "no model may be called");
    assert.equal(rec.updates[0].data.classificationStatus, "skipped");
    assert.equal(
      rec.updates[0].data.classification,
      null,
      "an unconfigured company must never have its articles rejected"
    );
  });
});

describe("classifyFeedItem — nothing to read", () => {
  it("settles as skipped rather than failing or rejecting", async () => {
    const { deps, rec } = makeDeps({});
    const out = await classifyFeedItem(item({ title: null, content: null }), SCOPED, deps);

    assert.deepEqual(out, { status: "skipped", reason: "no_content" });
    assert.equal(rec.prompts.length, 0);
    assert.equal(rec.updates[0].data.classification, null);
  });
});

// ─── Idempotency ──────────────────────────────────────────────────────────────

describe("classifyFeedItem — unchanged inputs", () => {
  const text = { title: "Как да изберем латекс", body: "Дълъг текст за боядисване на стени." };
  const hash = computeClassificationHash(text, SCOPED);

  it("costs no model call when the hash already matches", async () => {
    const { deps, rec } = makeDeps({});
    const out = await classifyFeedItem(
      item({ classificationHash: hash, classificationStatus: "completed" }),
      SCOPED,
      deps
    );

    assert.deepEqual(out, { status: "skipped", reason: "unchanged" });
    assert.equal(rec.prompts.length, 0);
  });

  it("settles a reopened-but-unchanged row straight back to completed", async () => {
    // This is what lets reclassification be triggered bluntly: a row whose text
    // and configuration did not really change costs one write, not a verdict.
    const { deps, rec } = makeDeps({});
    const out = await classifyFeedItem(
      item({ classificationHash: hash, classificationStatus: "pending" }),
      SCOPED,
      deps
    );

    assert.deepEqual(out, { status: "skipped", reason: "unchanged" });
    assert.equal(rec.prompts.length, 0);
    assert.equal(rec.updateManys[0].data.classificationStatus, "completed");
  });
});

// ─── Retry, lease, and the failure contract ───────────────────────────────────

describe("classifyFeedItem — claim and lease", () => {
  it("claims pending/failed rows and reclaims an expired lease", async () => {
    const { deps, rec } = makeDeps({ replies: [understandingReply(), verdictReply()] });
    await classifyFeedItem(item(), SCOPED, deps);

    const claim = rec.updateManys[0].where.OR as Array<Record<string, unknown>>;
    assert.deepEqual(claim[0].classificationStatus, { in: ["pending", "failed"] });
    assert.equal(claim[1].classificationStatus, "classifying");
    assert.deepEqual(claim[1].classificationLeaseExpiresAt, { lt: NOW });
  });

  it("counts the attempt at claim time and stamps a lease", async () => {
    const { deps, rec } = makeDeps({ replies: [understandingReply(), verdictReply()] });
    await classifyFeedItem(item({ classificationAttemptCount: 1 }), SCOPED, deps);

    assert.equal(rec.updateManys[0].data.classificationAttemptCount, 2);
    assert.ok(rec.updateManys[0].data.classificationLeaseExpiresAt instanceof Date);
  });

  it("skips without calling the model when another run holds the item", async () => {
    const { deps, rec } = makeDeps({
      replies: [understandingReply(), verdictReply()],
      claimWins: false,
    });
    const out = await classifyFeedItem(item(), SCOPED, deps);

    assert.deepEqual(out, { status: "skipped", reason: "claimed" });
    assert.equal(rec.prompts.length, 0);
  });

  it("stops once the attempt budget is spent", async () => {
    const { deps, rec } = makeDeps({ replies: [understandingReply(), verdictReply()] });
    const out = await classifyFeedItem(item({ classificationAttemptCount: 3 }), SCOPED, deps);

    assert.deepEqual(out, { status: "skipped", reason: "max_attempts" });
    assert.equal(rec.prompts.length, 0);
  });

  it("fences its success write on the lease it stamped", async () => {
    const { deps, rec } = makeDeps({ replies: [understandingReply(), verdictReply()] });
    await classifyFeedItem(item(), SCOPED, deps);

    const write = rec.updateManys[1];
    assert.equal(write.where.classificationStatus, "classifying");
    assert.ok(write.where.classificationLeaseExpiresAt instanceof Date);
  });

  it("discards a late verdict when the item was reclaimed meanwhile", async () => {
    const { deps } = makeDeps({
      replies: [understandingReply(), verdictReply()],
      writeWins: false,
    });
    const out = await classifyFeedItem(item(), SCOPED, deps);
    assert.deepEqual(out, { status: "skipped", reason: "claimed" });
  });
});

describe("classifyFeedItem — failure is never a rejection", () => {
  it("records a provider failure as `failed` and writes no verdict", async () => {
    const { deps, rec } = makeDeps({ throwOnGenerate: new Error("connection reset") });
    const out = await classifyFeedItem(item(), SCOPED, deps);

    assert.equal(out.status, "failed");
    const write = rec.updateManys[1];
    assert.equal(write.data.classificationStatus, "failed");
    assert.equal(
      "classification" in write.data,
      false,
      "a failure must not touch the verdict columns at all"
    );
    assert.match(String(write.data.classificationError), /connection reset/);
  });

  it("records an article-understanding failure as `failed`, not REJECTED", async () => {
    // Two prose replies: the understanding call's own repair is tried once,
    // then given up on — the verdict call is never reached.
    const { deps, rec } = makeDeps({ replies: ["not json", "still not json"] });
    const out = await classifyFeedItem(item(), SCOPED, deps);

    assert.equal(out.status, "failed");
    assert.equal(rec.prompts.length, 2, "one repair call for understanding, then give up");
    const write = rec.updateManys[1];
    assert.equal(write.data.classificationStatus, "failed");
    assert.equal("classification" in write.data, false);
  });

  it("records an untrustworthy VERDICT reply as `failed`, not REJECTED — understanding itself succeeded", async () => {
    const { deps, rec } = makeDeps({
      replies: [understandingReply(), "not json", "still not json"],
    });
    const out = await classifyFeedItem(item(), SCOPED, deps);

    assert.equal(out.status, "failed");
    assert.equal(
      rec.prompts.length,
      3,
      "one understanding call, then one verdict call and its repair"
    );
    const write = rec.updateManys[1];
    assert.equal(write.data.classificationStatus, "failed");
    assert.equal("classification" in write.data, false);
  });

  it("leaves the item untouched and uncounted when no provider is configured", async () => {
    const { deps, rec } = makeDeps({ noProvider: true });
    const out = await classifyFeedItem(item(), SCOPED, deps);

    assert.deepEqual(out, { status: "no_provider" });
    assert.equal(rec.updateManys.length, 0, "no claim, so no attempt is burned");
    assert.equal(rec.updates.length, 0);
  });

  it("repairs a bad VERDICT reply and stores the corrected verdict", async () => {
    const { deps, rec } = makeDeps({
      replies: [understandingReply(), "prose", verdictReply()],
    });
    const out = await classifyFeedItem(item(), SCOPED, deps);

    assert.equal(out.status, "classified");
    assert.equal(rec.prompts.length, 3);
    assert.match(rec.prompts[2], /previous answer was rejected/);
    assert.equal(rec.updateManys[1].data.classification, "HIGH");
  });
});

describe("classifyFeedItem — a successful run", () => {
  it("understands the article once, then classifies from that understanding alone", async () => {
    const { deps, rec } = makeDeps({
      replies: [understandingReply(), verdictReply()],
    });
    const out = await classifyFeedItem(
      item({ classificationStatus: "failed", classificationAttemptCount: 1 }),
      SCOPED,
      deps
    );

    assert.equal(out.status, "classified");
    assert.equal(rec.prompts.length, 2, "exactly one understanding call and one verdict call");
    const data = rec.updateManys[1].data;
    assert.equal(data.classification, "HIGH");
    assert.equal(data.classificationStatus, "completed");
    assert.deepEqual(data.classificationMatchedTopics, ["бои"]);
    assert.equal(data.classificationReason, "About choosing paint.");
    assert.equal(data.classificationError, null, "a successful retry clears the old error");
    assert.equal(data.classificationLeaseExpiresAt, null, "the lease is released");
    assert.equal(data.classificationProvider, "TEXT_WORKER");
  });

  it("judges the TRANSLATED text when a translation completed", async () => {
    const { deps, rec } = makeDeps({
      replies: [understandingReply(), verdictReply()],
    });
    await classifyFeedItem(
      item({
        title: "Original English title",
        content: "English body.",
        translationStatus: "completed",
        translatedTitle: "Български заглавие",
        translatedContent: "Български текст за бои.",
      }),
      SCOPED,
      deps
    );

    // The UNDERSTANDING call is the one that ever reads article text at all.
    assert.match(rec.prompts[0], /Български текст за бои/);
    assert.equal(rec.prompts[0].includes("English body."), false);
  });

  it("stores mainSubject from ArticleUnderstanding — never from the verdict reply", async () => {
    const { deps, rec } = makeDeps({
      replies: [
        understandingReply({ mainSubject: "Как да изберем латекс за детска стая." }),
        verdictReply(),
      ],
    });
    await classifyFeedItem(item(), SCOPED, deps);

    assert.equal(
      rec.updateManys[1].data.classificationMainSubject,
      "Как да изберем латекс за детска стая."
    );
  });

  it("the final verdict call cannot replace ArticleUnderstanding.mainSubject with a different subject", async () => {
    // Even if a verdict reply smuggles in its own "mainSubject" field, the
    // verdict parser does not read it — feed-item-classification.test.ts
    // proves ClassificationVerdict never carries one. This proves the
    // service-level consequence: the STORED value is unaffected.
    const { deps, rec } = makeDeps({
      replies: [
        understandingReply({ mainSubject: "The real, established subject." }),
        verdictReply({ mainSubject: "A different subject the verdict call invented." }),
      ],
    });
    await classifyFeedItem(item(), SCOPED, deps);

    assert.equal(
      rec.updateManys[1].data.classificationMainSubject,
      "The real, established subject."
    );
  });
});

// ─── Whole-article classification: understanding happens ONCE ─────────────────
//
// A chunked/segmented translation (ollama-chunking.ts) reassembles ALL of its
// chunks into one `translatedContent` before `translationStatus` is ever
// written `completed` — a partial run fails or stays `pending` instead (see
// translate-feed-item.service.ts). So a `completed` row here always carries
// the WHOLE reassembled article, which can run far longer than a single-call
// translation ever could.
//
// Chunking now happens entirely INSIDE `understandArticle` — reusing
// `classification-chunk-analysis.ts`'s per-chunk prompt/parser, not a second
// copy of it (see that module's own test suite and `understand-article.service.test.ts`
// for the chunking/reduction machinery itself). This service never plans
// chunks, never analyzes one, and never banks per-chunk progress of its own —
// the whole-article chunk-analysis-then-aggregate path it used to run is
// bypassed entirely; these tests prove the SERVICE-level consequence: N chunk
// calls plus ONE synthesis call plus ONE verdict call, never chunked twice.

/** Real sentences (not "a".repeat) — the splitter needs sentence punctuation. */
const SENTENCE = "This is one ordinary sentence about home renovation topics today. ";

describe("classifyFeedItem — whole-article classification of a long, chunked translation", () => {
  it("understands via N chunk-analysis calls + 1 synthesis call, then makes exactly ONE verdict call", async () => {
    const translatedContent = SENTENCE.repeat(400); // well over one classification call
    const chunkCount = planClassificationChunks(null, translatedContent).chunks.length;
    assert.ok(chunkCount > 1, "test fixture must actually need chunking");

    // Every chunk agrees on the same central topic, so the deterministic
    // confidence ceiling (see article-understanding.ts) does not suppress the
    // scripted HIGH verdict below — this test is about call COUNTS, not
    // confidence, so the fixture keeps confidence comfortably out of the way.
    const { deps, rec } = makeDeps({
      replies: [
        ...Array(chunkCount).fill(chunkReply({ centrality: "central", topics: ["paints"] })),
        understandingReply(),
        verdictReply(),
      ],
    });
    const out = await classifyFeedItem(
      item({ translationStatus: "completed", translatedTitle: "t", translatedContent }),
      SCOPED,
      deps
    );

    assert.equal(out.status, "classified");
    assert.equal(
      rec.prompts.length,
      chunkCount + 2,
      "N chunk calls + 1 synthesis call (understanding), then exactly one verdict call"
    );
    // Every chunk prompt names its position, so the log/trace can explain
    // "chunk 3 of 7" rather than just a raw count.
    assert.match(rec.prompts[0], /Section 1 of/);
  });

  it("a fact found only in a LATE chunk survives into the understanding, and from there into the final verdict prompt", async () => {
    // Opens on a topic the company has NOT configured; the real, configured
    // subject is only found in the LAST chunk — exactly the shape a naive
    // slice(0, N) or an opening-only read would have missed entirely.
    const opening = "Fast-growing trees you can get for free this spring. ";
    const translatedContent = opening + SENTENCE.repeat(400);
    const chunkCount = planClassificationChunks(null, translatedContent).chunks.length;
    assert.ok(chunkCount > 1);

    const replies = [
      ...Array(chunkCount - 1).fill(chunkReply({ centrality: "supporting" })),
      chunkReply({
        mainPoint: "TRUE_SUBJECT_MARKER: choosing latex paint for a nursery.",
        topics: ["paints"],
        centrality: "central",
      }),
      understandingReply({
        mainSubject: "TRUE_SUBJECT_MARKER: choosing latex paint for a nursery.",
        evidence: [{ chunkIndex: chunkCount - 1, reason: "names the real subject" }],
      }),
      verdictReply(),
    ];
    const { deps, rec } = makeDeps({ replies });
    const out = await classifyFeedItem(
      item({ translationStatus: "completed", translatedTitle: "t", translatedContent }),
      SCOPED,
      deps
    );

    assert.equal(out.status, "classified");
    const verdictPrompt = rec.prompts[rec.prompts.length - 1];
    assert.ok(
      verdictPrompt.includes("TRUE_SUBJECT_MARKER"),
      "a subject found only via the LAST chunk must survive synthesis into the final verdict call"
    );
    assert.match(verdictPrompt, /MAIN SUBJECT:/);
    assert.equal(
      rec.updateManys[1].data.classificationMainSubject,
      "TRUE_SUBJECT_MARKER: choosing latex paint for a nursery."
    );
  });

  it("never sends an unbounded prompt, however long the reassembled article is", async () => {
    const translatedContent = SENTENCE.repeat(3000); // a genuinely huge feature article
    const chunkCount = planClassificationChunks(null, translatedContent).chunks.length;
    const { deps, rec } = makeDeps({
      replies: [...Array(chunkCount).fill(chunkReply()), understandingReply(), verdictReply()],
    });
    await classifyFeedItem(
      item({ translationStatus: "completed", translatedTitle: "t", translatedContent }),
      SCOPED,
      deps
    );

    for (const prompt of rec.prompts) {
      assert.ok(
        prompt.length < 6000,
        `expected every single call to stay bounded, got ${prompt.length}`
      );
    }
  });

  it("stores the final verdict exactly like the short path — same columns, same shape", async () => {
    const translatedContent = SENTENCE.repeat(400);
    const chunkCount = planClassificationChunks(null, translatedContent).chunks.length;
    const { deps, rec } = makeDeps({
      replies: [
        ...Array(chunkCount).fill(chunkReply({ centrality: "central", topics: ["paints"] })),
        understandingReply(),
        verdictReply(),
      ],
    });
    await classifyFeedItem(
      item({ translationStatus: "completed", translatedTitle: "t", translatedContent }),
      SCOPED,
      deps
    );

    const write = rec.updateManys[1].data;
    assert.equal(write.classification, "HIGH");
    assert.equal(write.classificationStatus, "completed");
  });
});

// ─── Company context ──────────────────────────────────────────────────────────

describe("classifyFeedItem — company context", () => {
  it("puts the brand copy in the VERDICT prompt, ahead of the topics — understanding itself is company-agnostic", async () => {
    const { deps, rec } = makeDeps({ replies: [understandingReply(), verdictReply()] });
    await classifyFeedItem(item(), SCOPED_WITH_CONTEXT, deps);

    const verdictPrompt = rec.prompts[1];
    assert.ok(verdictPrompt.includes(DESCRIPTION));
    assert.ok(verdictPrompt.includes(AUDIENCE));
    assert.ok(
      verdictPrompt.indexOf("## The company") < verdictPrompt.indexOf("## The company's topics")
    );
    // The understanding call never sees company context at all.
    assert.equal(rec.prompts[0].includes(DESCRIPTION), false);
  });

  it("sends no company section when the brand copy is blank", async () => {
    const { deps, rec } = makeDeps({ replies: [understandingReply(), verdictReply()] });
    await classifyFeedItem(item(), SCOPED, deps);

    assert.ok(!rec.prompts[1].includes("## The company\n"));
  });

  /**
   * The two halves of the backwards-compatibility contract, from the caller's
   * side: adding brand copy makes a stored verdict stale, and NOT having any
   * leaves the hash exactly where it was.
   */
  it("changes the stored hash when the brand copy changes", async () => {
    const { deps, rec } = makeDeps({ replies: [understandingReply(), verdictReply()] });
    await classifyFeedItem(item(), SCOPED_WITH_CONTEXT, deps);
    const withCopy = rec.updateManys[1].data.classificationHash;

    const second = makeDeps({ replies: [understandingReply(), verdictReply()] });
    await classifyFeedItem(item(), SCOPED, second.deps);
    const withoutCopy = second.rec.updateManys[1].data.classificationHash;

    assert.notEqual(withCopy, withoutCopy);
  });

  it("settles as unchanged against a hash computed without brand copy", async () => {
    // A company that has never written a description must not have every stored
    // verdict invalidated by this feature shipping.
    const text = { title: "Как да изберем латекс", body: "Дълъг текст за боядисване на стени." };
    const { deps, rec } = makeDeps({ replies: [understandingReply(), verdictReply()] });
    const out = await classifyFeedItem(
      item({
        classificationHash: computeClassificationHash(text, SCOPED),
        classificationStatus: "completed",
      }),
      SCOPED,
      deps
    );

    assert.deepEqual(out, { status: "skipped", reason: "unchanged" });
    assert.equal(rec.prompts.length, 0, "no model call for an unchanged item");
  });
});

describe("classifyFeedItem — the diagnostic columns", () => {
  it("stores the main subject (from ArticleUnderstanding) and the deciding topic alongside the verdict", async () => {
    const { deps, rec } = makeDeps({
      replies: [understandingReply({ mainSubject: "Избор на латекс за стени." }), verdictReply()],
    });
    const out = await classifyFeedItem(item(), SCOPED, deps);

    assert.equal(out.status, "classified");
    const write = rec.updateManys[1].data;
    assert.equal(write.classification, "HIGH");
    assert.equal(write.classificationMainSubject, "Избор на латекс за стени.");
    assert.equal(write.classificationPrimaryTopic, "бои");
  });

  it("clears them on a settled non-answer, so no stale subject survives", async () => {
    const { deps, rec } = makeDeps({});
    await classifyFeedItem(item(), NONE, deps);

    assert.equal(rec.updates[0].data.classificationMainSubject, null);
    assert.equal(rec.updates[0].data.classificationPrimaryTopic, null);
  });

  it("leaves them untouched on a failure — a failure is not a verdict", async () => {
    const { deps, rec } = makeDeps({ throwOnGenerate: new Error("connection reset") });
    await classifyFeedItem(item(), SCOPED, deps);

    const write = rec.updateManys[1].data;
    assert.equal(write.classificationStatus, "failed");
    assert.ok(!("classificationMainSubject" in write));
    assert.ok(!("classificationPrimaryTopic" in write));
  });

  it("repairs a VERDICT reply whose primary topic contradicts its label", async () => {
    // Mainly about ventilation, returned as HIGH. The repair call is told exactly
    // that, and the corrected reply is what gets stored.
    const promoted = verdictReply({
      primaryTopic: "вентилация",
      classification: "HIGH",
      matchedTopics: ["вентилация", "бои"],
    });
    const corrected = verdictReply({
      primaryTopic: "вентилация",
      classification: "MEDIUM",
      matchedTopics: ["вентилация", "бои"],
    });

    const { deps, rec } = makeDeps({
      replies: [
        understandingReply({ mainSubject: "Монтаж на вентилатор за таван." }),
        promoted,
        corrected,
      ],
    });
    const out = await classifyFeedItem(item(), SCOPED, deps);

    assert.equal(out.status, "classified");
    assert.equal(rec.prompts.length, 3, "the bad reply must be repaired, not stored");
    assert.match(rec.prompts[2], /MAINLY about/);
    assert.equal(rec.updateManys[1].data.classification, "MEDIUM");
    assert.equal(rec.updateManys[1].data.classificationPrimaryTopic, "вентилация");
  });
});

// ─── Integration regressions (v2-14) ───────────────────────────────────────────
//
// These prove the END-TO-END wiring: `understandArticle`'s output is what the
// verdict call is judged from, the verdict call cannot invent a different
// subject, and the topic-matching rules classification always enforced still
// hold once the article representation is `ArticleUnderstanding` rather than
// raw or aggregated text.

describe("classifyFeedItem — integration regressions", () => {
  it("misleading opening: classification follows ArticleUnderstanding's subject, not an opening topic the company never configured", async () => {
    const opening = "A round-up of the best garden furniture for spring. ";
    const translatedContent = opening + SENTENCE.repeat(400);
    const chunkCount = planClassificationChunks(null, translatedContent).chunks.length;

    const replies = [
      chunkReply({ mainPoint: "Garden furniture ideas for spring.", topics: ["garden"] }),
      ...Array(chunkCount - 2).fill(chunkReply()),
      chunkReply({
        mainPoint: "The article pivots to explain how to choose interior wall paint.",
        topics: ["paints"],
        centrality: "central",
      }),
      understandingReply({ mainSubject: "Choosing interior wall paint for a home renovation." }),
      verdictReply(),
    ];
    const { deps, rec } = makeDeps({ replies });
    const out = await classifyFeedItem(
      item({ translationStatus: "completed", translatedTitle: "t", translatedContent }),
      SCOPED,
      deps
    );

    assert.equal(out.status, "classified");
    assert.equal(rec.updateManys[1].data.classification, "HIGH");
    assert.equal(
      rec.updateManys[1].data.classificationMainSubject,
      "Choosing interior wall paint for a home renovation."
    );
  });

  it("incidental brand topic: a topic the company configured, mentioned only incidentally, does not become the match", async () => {
    const { deps, rec } = makeDeps({
      replies: [
        understandingReply({
          mainSubject: "A general guide to spring home maintenance checklists.",
          incidentalTopics: ["repainting a fence"],
        }),
        verdictReply({
          classification: "REJECTED",
          rejectionReason: "OUT_OF_SCOPE",
          primaryTopic: null,
          matchedTopics: [],
          reason: "The main subject is a general checklist, not paint.",
        }),
      ],
    });
    const out = await classifyFeedItem(item(), SCOPED, deps);

    assert.equal(out.status, "classified");
    assert.equal(rec.updateManys[1].data.classification, "REJECTED");
    assert.equal(rec.updateManys[1].data.classificationRejectionReason, "OUT_OF_SCOPE");
  });

  it("repeated incidental brand mentions across many chunks do not create a HIGH or MEDIUM match", async () => {
    const translatedContent = SENTENCE.repeat(400);
    const chunkCount = planClassificationChunks(null, translatedContent).chunks.length;
    const replies = [
      // Every chunk mentions "paints" in passing, but none is central.
      ...Array(chunkCount).fill(chunkReply({ topics: ["paints"], centrality: "supporting" })),
      understandingReply({
        mainSubject: "A general round-up of home-improvement television shows.",
        incidentalTopics: ["paints"],
      }),
      verdictReply({
        classification: "REJECTED",
        rejectionReason: "OUT_OF_SCOPE",
        primaryTopic: null,
        matchedTopics: [],
        reason: "The main subject is TV shows, not paint.",
      }),
    ];
    const { deps, rec } = makeDeps({ replies });
    const out = await classifyFeedItem(
      item({ translationStatus: "completed", translatedTitle: "t", translatedContent }),
      SCOPED,
      deps
    );

    assert.equal(out.status, "classified");
    assert.equal(rec.updateManys[1].data.classification, "REJECTED");
  });

  it("a true direct HIGH topic is classified HIGH", async () => {
    const { deps, rec } = makeDeps({
      replies: [
        understandingReply({ mainSubject: "How to choose latex paint for a nursery." }),
        verdictReply({ classification: "HIGH", primaryTopic: "бои", matchedTopics: ["бои"] }),
      ],
    });
    const out = await classifyFeedItem(item(), SCOPED, deps);

    assert.equal(out.status, "classified");
    assert.equal(rec.updateManys[1].data.classification, "HIGH");
  });

  it("a true direct MEDIUM topic is classified MEDIUM", async () => {
    const { deps, rec } = makeDeps({
      replies: [
        understandingReply({ mainSubject: "How ceiling ventilation fans work." }),
        verdictReply({
          classification: "MEDIUM",
          primaryTopic: "вентилация",
          matchedTopics: ["вентилация"],
        }),
      ],
    });
    const out = await classifyFeedItem(item(), SCOPED, deps);

    assert.equal(out.status, "classified");
    assert.equal(rec.updateManys[1].data.classification, "MEDIUM");
  });

  it("an avoided topic that IS the central subject is BLACKLIST", async () => {
    const { deps, rec } = makeDeps({
      replies: [
        understandingReply({ mainSubject: "Choosing and installing a wood-burning fireplace." }),
        verdictReply({
          classification: "REJECTED",
          rejectionReason: "BLACKLIST",
          primaryTopic: "камини",
          matchedTopics: ["камини"],
          reason: "The article is mainly about fireplaces.",
        }),
      ],
    });
    const out = await classifyFeedItem(item(), SCOPED, deps);

    assert.equal(out.status, "classified");
    assert.equal(rec.updateManys[1].data.classification, "REJECTED");
    assert.equal(rec.updateManys[1].data.classificationRejectionReason, "BLACKLIST");
  });

  it("an avoided topic mentioned only incidentally is NOT BLACKLIST", async () => {
    const { deps, rec } = makeDeps({
      replies: [
        understandingReply({
          mainSubject: "How to choose latex paint for a nursery.",
          incidentalTopics: ["a fireplace mentioned as a room feature"],
        }),
        verdictReply({ classification: "HIGH", primaryTopic: "бои", matchedTopics: ["бои"] }),
      ],
    });
    const out = await classifyFeedItem(item(), SCOPED, deps);

    assert.equal(out.status, "classified");
    assert.notEqual(rec.updateManys[1].data.classificationRejectionReason, "BLACKLIST");
  });

  it("a fire-extinguisher article cannot be smuggled onto бойлери — a correct model answers OUT_OF_SCOPE and the pipeline stores it as such", async () => {
    // Fire extinguishers and boilers are both "things installed in a home", but
    // neither is a synonym or a kind of the other. Deterministic validation can
    // only refuse an INVENTED topic name or a structurally inconsistent tier
    // (see feed-item-classification.ts) — it cannot itself judge that
    // "extinguisher" is not "бойлери" semantically, so this proves the honest,
    // achievable half: when the model correctly declines the match, nothing in
    // this pipeline second-guesses it into a false HIGH.
    const { deps, rec } = makeDeps({
      replies: [
        understandingReply({ mainSubject: "Избор на пожарогасител за дома." }),
        verdictReply({
          classification: "REJECTED",
          rejectionReason: "OUT_OF_SCOPE",
          primaryTopic: null,
          matchedTopics: [],
          reason: "Пожарогасителите не са конфигурирана тема.",
        }),
      ],
    });
    const out = await classifyFeedItem(item(), SCOPED, deps);

    assert.equal(out.status, "classified");
    assert.equal(rec.updateManys[1].data.classification, "REJECTED");
    // The VERDICT prompt must show the real, undistorted subject — a model
    // reading a mangled or paint-flavoured paraphrase would have no honest way
    // to decide correctly.
    assert.match(rec.prompts[1], /Избор на пожарогасител за дома/);
  });

  it("Albania case: classification is driven by the protest/tourism-development conflict, not generic travel vocabulary", async () => {
    const translatedContent = SENTENCE.repeat(400);
    const chunkCount = planClassificationChunks(null, translatedContent).chunks.length;
    const albania: ClassificationContext = {
      priorities: resolveTopicPriorities({ topPriorityTopics: ["местни протести"] }),
      companyDescription: null,
      targetAudience: null,
    };

    const replies = [
      chunkReply({ mainPoint: "Albania's coastline draws record tourists.", topics: ["tourism"] }),
      chunkReply({ mainPoint: "New beach resorts are under construction.", topics: ["beaches"] }),
      ...Array(chunkCount - 3).fill(chunkReply({ topics: ["scenery"] })),
      chunkReply({
        mainPoint: "Hundreds gathered to protest development in a protected coastal area.",
        topics: ["protest", "protected coastal area"],
        centrality: "central",
      }),
      understandingReply({
        mainSubject:
          "Residents in Albania are protesting new tourism development in a protected coastal area.",
        secondaryTopics: ["protected coastal area"],
        incidentalTopics: ["tourism", "beaches"],
        entities: ["Albania"],
        evidence: [{ chunkIndex: chunkCount - 1, reason: "names the protest" }],
      }),
      verdictReply({
        classification: "HIGH",
        primaryTopic: "местни протести",
        matchedTopics: ["местни протести"],
        reason: "The article's main subject is a local protest against development.",
      }),
    ];
    const { deps, rec } = makeDeps({ replies });
    const out = await classifyFeedItem(
      item({ translationStatus: "completed", translatedTitle: "t", translatedContent }),
      albania,
      deps
    );

    assert.equal(out.status, "classified");
    assert.equal(rec.updateManys[1].data.classification, "HIGH");
    assert.equal(rec.updateManys[1].data.classificationPrimaryTopic, "местни протести");
    assert.match(rec.updateManys[1].data.classificationMainSubject as string, /protest/i);

    const verdictPrompt = rec.prompts[rec.prompts.length - 1];
    const mainSubjectLine = verdictPrompt.slice(
      verdictPrompt.indexOf("MAIN SUBJECT:"),
      verdictPrompt.indexOf("CENTRAL THESIS:")
    );
    assert.match(mainSubjectLine, /protesting new tourism development/);
    assert.doesNotMatch(mainSubjectLine, /beaches/);
  });

  it("HIGH is refused (and repaired down) when ArticleUnderstanding's own confidence is too low", async () => {
    const lowConfidenceHigh = verdictReply({
      classification: "HIGH",
      primaryTopic: "бои",
      matchedTopics: ["бои"],
    });
    const corrected = verdictReply({
      classification: "REJECTED",
      rejectionReason: "OUT_OF_SCOPE",
      primaryTopic: null,
      matchedTopics: [],
      reason: "Too uncertain to call HIGH.",
    });

    const { deps, rec } = makeDeps({
      replies: [understandingReply({ confidence: 0.1 }), lowConfidenceHigh, corrected],
    });
    const out = await classifyFeedItem(item(), SCOPED, deps);

    assert.equal(out.status, "classified");
    assert.equal(rec.prompts.length, 3, "the low-confidence HIGH must be repaired, not stored");
    assert.match(rec.prompts[2], /UNDERSTANDING CONFIDENCE/);
    assert.equal(rec.updateManys[1].data.classification, "REJECTED");
  });
});
