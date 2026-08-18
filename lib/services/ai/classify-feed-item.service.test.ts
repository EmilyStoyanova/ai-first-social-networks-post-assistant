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
  noProvider?: boolean;
  claimWins?: boolean;
  writeWins?: boolean;
}): { deps: ClassifyFeedItemDeps; rec: Recorded } {
  const rec: Recorded = { updates: [], updateManys: [], prompts: [] };
  const replies = [...(opts.replies ?? [])];
  let updateManyCall = 0;

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
                if (opts.throwOnGenerate) throw opts.throwOnGenerate;
                return { text: replies.shift() ?? "" };
              },
            },
          },
  };

  return { deps, rec };
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
