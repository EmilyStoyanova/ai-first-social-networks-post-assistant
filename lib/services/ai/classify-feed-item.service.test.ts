import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
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
 * without a database.
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
    itemTimeoutMs: 2000,
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

/** A well-formed chunk-analysis reply. */
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

const okReply = JSON.stringify({
  mainSubject: "Избор на латекс за стени.",
  primaryTopic: "бои",
  classification: "HIGH",
  rejectionReason: null,
  matchedTopics: ["бои"],
  reason: "About choosing paint.",
});

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
    const { deps, rec } = makeDeps({ replies: [okReply] });
    await classifyFeedItem(item(), SCOPED, deps);

    const claim = rec.updateManys[0].where.OR as Array<Record<string, unknown>>;
    assert.deepEqual(claim[0].classificationStatus, { in: ["pending", "failed"] });
    assert.equal(claim[1].classificationStatus, "classifying");
    assert.deepEqual(claim[1].classificationLeaseExpiresAt, { lt: NOW });
  });

  it("counts the attempt at claim time and stamps a lease", async () => {
    const { deps, rec } = makeDeps({ replies: [okReply] });
    await classifyFeedItem(item({ classificationAttemptCount: 1 }), SCOPED, deps);

    assert.equal(rec.updateManys[0].data.classificationAttemptCount, 2);
    assert.ok(rec.updateManys[0].data.classificationLeaseExpiresAt instanceof Date);
  });

  it("skips without calling the model when another run holds the item", async () => {
    const { deps, rec } = makeDeps({ replies: [okReply], claimWins: false });
    const out = await classifyFeedItem(item(), SCOPED, deps);

    assert.deepEqual(out, { status: "skipped", reason: "claimed" });
    assert.equal(rec.prompts.length, 0);
  });

  it("stops once the attempt budget is spent", async () => {
    const { deps, rec } = makeDeps({ replies: [okReply] });
    const out = await classifyFeedItem(item({ classificationAttemptCount: 3 }), SCOPED, deps);

    assert.deepEqual(out, { status: "skipped", reason: "max_attempts" });
    assert.equal(rec.prompts.length, 0);
  });

  it("fences its success write on the lease it stamped", async () => {
    const { deps, rec } = makeDeps({ replies: [okReply] });
    await classifyFeedItem(item(), SCOPED, deps);

    const write = rec.updateManys[1];
    assert.equal(write.where.classificationStatus, "classifying");
    assert.ok(write.where.classificationLeaseExpiresAt instanceof Date);
  });

  it("discards a late verdict when the item was reclaimed meanwhile", async () => {
    const { deps } = makeDeps({ replies: [okReply], writeWins: false });
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

  it("records an untrustworthy reply as `failed`, not REJECTED", async () => {
    // Two prose replies: the first is repaired, the second still unusable.
    const { deps, rec } = makeDeps({ replies: ["not json", "still not json"] });
    const out = await classifyFeedItem(item(), SCOPED, deps);

    assert.equal(out.status, "failed");
    assert.equal(rec.prompts.length, 2, "one repair call, then give up");
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

  it("repairs a bad reply and stores the corrected verdict", async () => {
    const { deps, rec } = makeDeps({ replies: ["prose", okReply] });
    const out = await classifyFeedItem(item(), SCOPED, deps);

    assert.equal(out.status, "classified");
    assert.equal(rec.prompts.length, 2);
    assert.match(rec.prompts[1], /previous answer was rejected/);
    assert.equal(rec.updateManys[1].data.classification, "HIGH");
  });
});

describe("classifyFeedItem — a successful run", () => {
  it("stores the verdict, its evidence, and clears the stale error", async () => {
    const { deps, rec } = makeDeps({ replies: [okReply] });
    const out = await classifyFeedItem(
      item({ classificationStatus: "failed", classificationAttemptCount: 1 }),
      SCOPED,
      deps
    );

    assert.equal(out.status, "classified");
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
    const { deps, rec } = makeDeps({ replies: [okReply] });
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

    assert.match(rec.prompts[0], /Български текст за бои/);
    assert.equal(rec.prompts[0].includes("English body."), false);
  });
});

// ─── Whole-article classification after chunked translation ───────────────────
//
// A chunked/segmented translation (ollama-chunking.ts) reassembles ALL of its
// chunks into one `translatedContent` before `translationStatus` is ever
// written `completed` — a partial run fails or stays `pending` instead (see
// translate-feed-item.service.ts). So a `completed` row here always carries
// the WHOLE reassembled article, which can run far longer than a single-call
// translation ever could. These tests exercise the REAL chunk-analysis
// pipeline (planClassificationChunks + N chunk-analysis calls + 1 aggregate
// verdict call) against that shape of input — never a truncated or sampled
// excerpt of it.

/** Real sentences (not "a".repeat) — the splitter needs sentence punctuation. */
const SENTENCE = "This is one ordinary sentence about home renovation topics today. ";

describe("classifyFeedItem — whole-article classification of a long, chunked translation", () => {
  it("routes a long article through several chunk-analysis calls, then one verdict call", async () => {
    const translatedContent = SENTENCE.repeat(400); // well over one classification call
    const chunkCount = planClassificationChunks(null, translatedContent).chunks.length;
    assert.ok(chunkCount > 1, "test fixture must actually need chunking");

    const { deps, rec } = makeDeps({
      replies: [...Array(chunkCount).fill(chunkReply()), okReply],
    });
    const out = await classifyFeedItem(
      item({ translationStatus: "completed", translatedTitle: "t", translatedContent }),
      SCOPED,
      deps
    );

    assert.equal(out.status, "classified");
    assert.equal(
      rec.prompts.length,
      chunkCount + 1,
      "N chunk calls, then exactly one verdict call"
    );
    // Every chunk prompt names its position, so the log/trace can explain
    // "chunk 3 of 7" rather than just a raw count.
    assert.match(rec.prompts[0], /Section 1 of/);
  });

  it("carries a fact from a LATE chunk into the final verdict prompt — the bug this pipeline exists to fix", async () => {
    // Opens on a topic the company has NOT configured; the real, configured
    // subject is only found in the LAST chunk — exactly the shape a naive
    // slice(0, N) or an opening-only read would have missed entirely.
    const opening = "Fast-growing trees you can get for free this spring. ";
    const translatedContent = opening + SENTENCE.repeat(400);
    const chunkCount = planClassificationChunks(null, translatedContent).chunks.length;
    assert.ok(chunkCount > 1);

    const lateChunkAnalysis = chunkReply({
      mainPoint: "TRUE_SUBJECT_MARKER: choosing latex paint for a nursery.",
      topics: ["paints"],
      centrality: "central",
    });
    const replies = [
      ...Array(chunkCount - 1).fill(chunkReply({ centrality: "supporting" })),
      lateChunkAnalysis,
      okReply,
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
      "a fact found only in the LAST chunk must survive synthesis into the final verdict call"
    );
    assert.match(verdictPrompt, /CENTRAL —/);
  });

  it("never sends an unbounded prompt, however long the reassembled article is", async () => {
    const translatedContent = SENTENCE.repeat(3000); // a genuinely huge feature article
    const chunkCount = planClassificationChunks(null, translatedContent).chunks.length;
    const { deps, rec } = makeDeps({
      replies: [...Array(chunkCount).fill(chunkReply()), okReply],
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
      replies: [...Array(chunkCount).fill(chunkReply()), okReply],
    });
    await classifyFeedItem(
      item({ translationStatus: "completed", translatedTitle: "t", translatedContent }),
      SCOPED,
      deps
    );

    const write = rec.updateManys[1].data;
    assert.equal(write.classification, "HIGH");
    assert.equal(write.classificationStatus, "completed");
    assert.equal(
      write.classificationChunkProgress,
      Prisma.JsonNull,
      "banked progress is cleared on success"
    );
  });
});

describe("classifyFeedItem — chunk-analysis resumability", () => {
  const translatedContent = SENTENCE.repeat(400);
  const chunkCount = planClassificationChunks(null, translatedContent).chunks.length;
  const resolvedText = { title: null, body: translatedContent };

  it("skips a chunk already banked by an earlier, interrupted attempt", async () => {
    const hash = computeClassificationHash(resolvedText, SCOPED);
    const { deps, rec } = makeDeps({
      // Only chunkCount - 1 chunk replies: chunk 0 is resumed, never re-asked.
      replies: [...Array(chunkCount - 1).fill(chunkReply()), okReply],
    });
    const out = await classifyFeedItem(
      item({
        translationStatus: "completed",
        translatedTitle: null,
        translatedContent,
        classificationChunkProgress: { hash, chunks: { "0": JSON.parse(chunkReply()) } },
      }),
      SCOPED,
      deps
    );

    assert.equal(out.status, "classified");
    assert.equal(rec.prompts.length, chunkCount - 1 + 1, "one fewer chunk call, plus the verdict");
  });

  it("discards banked progress when the hash no longer matches — the article changed", async () => {
    const { deps, rec } = makeDeps({
      replies: [...Array(chunkCount).fill(chunkReply()), okReply],
    });
    const out = await classifyFeedItem(
      item({
        translationStatus: "completed",
        translatedTitle: null,
        translatedContent,
        classificationChunkProgress: {
          hash: "stale-hash-from-a-different-article-version",
          chunks: { "0": JSON.parse(chunkReply()) },
        },
      }),
      SCOPED,
      deps
    );

    assert.equal(out.status, "classified");
    assert.equal(
      rec.prompts.length,
      chunkCount + 1,
      "every chunk is re-analyzed — nothing trusted"
    );
  });
});

describe("classifyFeedItem — chunk-analysis partial progress", () => {
  const translatedContent = SENTENCE.repeat(400);
  const chunkCount = planClassificationChunks(null, translatedContent).chunks.length;

  it("banks progress and reports `partial` when a chunk cannot be analyzed, with attempts remaining", async () => {
    // The SECOND chunk call fails; the first already succeeded.
    const { deps, rec } = makeDeps({
      replies: [chunkReply()],
      throwOnCallIndex: 1,
    });
    const out = await classifyFeedItem(
      item({ translationStatus: "completed", translatedTitle: null, translatedContent }),
      SCOPED,
      deps
    );

    assert.deepEqual(out, {
      status: "partial",
      processedChunkCount: 1,
      totalChunkCount: chunkCount,
    });
    const write = rec.updateManys[1].data;
    assert.equal(
      write.classificationStatus,
      "pending",
      "resumes on the very next selection, no backoff"
    );
    assert.equal(write.classificationLeaseExpiresAt, null);
    const banked = write.classificationChunkProgress as {
      hash: string;
      chunks: Record<string, unknown>;
    };
    assert.equal(Object.keys(banked.chunks).length, 1);
  });

  it("fails terminally, but preserves banked chunks, once the attempt budget is spent", async () => {
    const { deps, rec } = makeDeps({
      replies: [chunkReply()],
      throwOnCallIndex: 1,
    });
    const out = await classifyFeedItem(
      item({
        translationStatus: "completed",
        translatedTitle: null,
        translatedContent,
        classificationAttemptCount: 2, // this is attempt 3 of MAX_CLASSIFICATION_ATTEMPTS (3)
      }),
      SCOPED,
      deps
    );

    assert.equal(out.status, "failed");
    const write = rec.updateManys[1].data;
    assert.equal(write.classificationStatus, "failed");
    const banked = write.classificationChunkProgress as {
      hash: string;
      chunks: Record<string, unknown>;
    };
    assert.equal(
      Object.keys(banked.chunks).length,
      1,
      "the chunk that DID succeed must not be thrown away just because the item as a whole failed"
    );
  });
});

// ─── Company context ──────────────────────────────────────────────────────────

describe("classifyFeedItem — company context", () => {
  it("puts the brand copy in the prompt, ahead of the topics", async () => {
    const { deps, rec } = makeDeps({ replies: [okReply] });
    await classifyFeedItem(item(), SCOPED_WITH_CONTEXT, deps);

    const prompt = rec.prompts[0];
    assert.ok(prompt.includes(DESCRIPTION));
    assert.ok(prompt.includes(AUDIENCE));
    assert.ok(prompt.indexOf("## The company") < prompt.indexOf("## The company's topics"));
  });

  it("sends no company section when the brand copy is blank", async () => {
    const { deps, rec } = makeDeps({ replies: [okReply] });
    await classifyFeedItem(item(), SCOPED, deps);

    assert.ok(!rec.prompts[0].includes("## The company\n"));
  });

  /**
   * The two halves of the backwards-compatibility contract, from the caller's
   * side: adding brand copy makes a stored verdict stale, and NOT having any
   * leaves the hash exactly where it was.
   */
  it("changes the stored hash when the brand copy changes", async () => {
    const { deps, rec } = makeDeps({ replies: [okReply] });
    await classifyFeedItem(item(), SCOPED_WITH_CONTEXT, deps);
    const withCopy = rec.updateManys[1].data.classificationHash;

    const second = makeDeps({ replies: [okReply] });
    await classifyFeedItem(item(), SCOPED, second.deps);
    const withoutCopy = second.rec.updateManys[1].data.classificationHash;

    assert.notEqual(withCopy, withoutCopy);
  });

  it("settles as unchanged against a hash computed without brand copy", async () => {
    // A company that has never written a description must not have every stored
    // verdict invalidated by this feature shipping.
    const text = { title: "Как да изберем латекс", body: "Дълъг текст за боядисване на стени." };
    const { deps, rec } = makeDeps({ replies: [okReply] });
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
  it("stores the main subject and the deciding topic alongside the verdict", async () => {
    const { deps, rec } = makeDeps({ replies: [okReply] });
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

  it("repairs a reply whose primary topic contradicts its label", async () => {
    // Mainly about ventilation, returned as HIGH. The repair call is told exactly
    // that, and the corrected reply is what gets stored.
    const promoted = JSON.stringify({
      mainSubject: "Монтаж на вентилатор за таван.",
      primaryTopic: "вентилация",
      classification: "HIGH",
      rejectionReason: null,
      matchedTopics: ["вентилация", "бои"],
      reason: "x",
    });
    const corrected = JSON.stringify({
      mainSubject: "Монтаж на вентилатор за таван.",
      primaryTopic: "вентилация",
      classification: "MEDIUM",
      rejectionReason: null,
      matchedTopics: ["вентилация", "бои"],
      reason: "x",
    });

    const { deps, rec } = makeDeps({ replies: [promoted, corrected] });
    const out = await classifyFeedItem(item(), SCOPED, deps);

    assert.equal(out.status, "classified");
    assert.equal(rec.prompts.length, 2, "the bad reply must be repaired, not stored");
    assert.match(rec.prompts[1], /MAINLY about/);
    assert.equal(rec.updateManys[1].data.classification, "MEDIUM");
    assert.equal(rec.updateManys[1].data.classificationPrimaryTopic, "вентилация");
  });
});
