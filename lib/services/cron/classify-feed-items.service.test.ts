import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyFeedItems,
  classificationEligibleWhere,
  type ClassifyFeedItemsDeps,
} from "./classify-feed-items.service";
import type { ClassificationContext } from "@/lib/ai/feed-item-classification";
import type { ClassifiableItem } from "@/lib/services/ai/classify-feed-item.service";
import { resolveTopicPriorities } from "@/lib/ai/topic-priorities";

const SCOPED: ClassificationContext = {
  priorities: resolveTopicPriorities({
    topPriorityTopics: ["бои"],
    mediumPriorityTopics: ["вентилация"],
  }),
  companyDescription: "Доместико продава бои и бойлери.",
  targetAudience: "Собственици на жилища.",
};

const NONE: ClassificationContext = {
  priorities: resolveTopicPriorities(null),
  companyDescription: null,
  targetAudience: null,
};

function item(id: string): ClassifiableItem {
  return {
    id,
    title: `Статия ${id}`,
    content: "Текст.",
    url: `https://example.com/${id}`,
    translationStatus: null,
    classificationStatus: "pending",
    classificationHash: null,
    classificationAttemptCount: 0,
  };
}

/**
 * Records what the run asked for and what it handed each item, which is the whole
 * surface this drain has: it loads a context and passes it on.
 */
function makeDeps(opts: { items?: ClassifiableItem[]; context?: ClassificationContext }): {
  deps: ClassifyFeedItemsDeps;
  rec: { contextLoads: string[]; handed: ClassificationContext[] };
} {
  const rec = { contextLoads: [] as string[], handed: [] as ClassificationContext[] };
  const context = opts.context ?? SCOPED;

  return {
    rec,
    deps: {
      findCandidates: async () => opts.items ?? [item("a"), item("b"), item("c")],
      loadContext: async (companyId) => {
        rec.contextLoads.push(companyId);
        return context;
      },
      classify: async (_item, handed) => {
        rec.handed.push(handed);
        return { status: "skipped", reason: "unchanged" };
      },
    },
  };
}

describe("classifyFeedItems — the classification context", () => {
  /**
   * The configuration cannot change mid-batch, so loading it per item would
   * multiply the cheapest part of the step by the batch size for no new answer.
   */
  it("loads the context once per run, not once per item", async () => {
    const { deps, rec } = makeDeps({});
    const summary = await classifyFeedItems({ companyId: "co-1" }, deps);

    assert.deepEqual(rec.contextLoads, ["co-1"]);
    assert.equal(rec.handed.length, 3);
    assert.equal(summary.scanned, 3);
  });

  it("hands every item the same context, brand copy included", async () => {
    const { deps, rec } = makeDeps({});
    await classifyFeedItems({ companyId: "co-1" }, deps);

    for (const handed of rec.handed) {
      assert.equal(handed, SCOPED, "the loaded context must be passed through unchanged");
      assert.equal(handed.companyDescription, SCOPED.companyDescription);
      assert.equal(handed.targetAudience, SCOPED.targetAudience);
    }
  });

  it("does not load a context when there is nothing to classify", async () => {
    const { deps, rec } = makeDeps({ items: [] });
    const summary = await classifyFeedItems({ companyId: "co-1" }, deps);

    assert.deepEqual(rec.contextLoads, []);
    assert.equal(summary.scanned, 0);
  });

  /**
   * "Configured" is still decided by the TOPICS alone. Brand copy is context, not
   * a rule: a company that wrote a description but listed no topics has configured
   * nothing, and its articles must keep settling with no verdict.
   */
  it("treats brand copy without topics as unconfigured", async () => {
    const copyOnly: ClassificationContext = {
      ...NONE,
      companyDescription: "Продаваме всичко за дома.",
    };
    const { deps, rec } = makeDeps({ context: copyOnly });

    // remainingMs would stop a configured run early; an unconfigured one ignores
    // it, because each item costs one settling write and no model call.
    const summary = await classifyFeedItems({ companyId: "co-1", remainingMs: () => 0 }, deps);

    assert.equal(summary.scanned, 3);
    assert.equal(rec.handed.length, 3);
  });
});

describe("classificationEligibleWhere", () => {
  it("waits for translation to settle before judging the text", async () => {
    const where = classificationEligibleWhere(new Date("2026-08-18T12:00:00Z"));
    const [scope] = where.AND as Array<Record<string, unknown>>;

    assert.equal(scope.usedInPost, false);
    assert.deepEqual(scope.source, { enabled: true, type: "rss" });
    assert.deepEqual(scope.OR, [
      { translationStatus: null },
      { translationStatus: { in: ["completed", "skipped", "failed"] } },
    ]);
  });
});
