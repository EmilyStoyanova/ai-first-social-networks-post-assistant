import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyFeedItems,
  classificationEligibleWhere,
  type ClassifyFeedItemsDeps,
} from "./classify-feed-items.service";
import {
  MAX_CLASSIFICATION_ATTEMPTS,
  type ClassificationContext,
} from "@/lib/ai/feed-item-classification";
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

describe("classifyFeedItems — tallying outcomes", () => {
  it("counts `partial` separately from classified/failed/skipped", async () => {
    const items = [item("a"), item("b"), item("c")];
    let call = 0;
    const deps: ClassifyFeedItemsDeps = {
      findCandidates: async () => items,
      loadContext: async () => SCOPED,
      classify: async () => {
        call += 1;
        if (call === 1)
          return {
            status: "classified",
            classification: "HIGH",
            rejectionReason: null,
            matchedTopics: ["бои"],
            provider: "p",
            model: "m",
          };
        if (call === 2) return { status: "partial", processedChunkCount: 2, totalChunkCount: 5 };
        return { status: "failed", error: "x" };
      },
    };
    const summary = await classifyFeedItems({ companyId: "co-1" }, deps);
    assert.equal(summary.classified, 1);
    assert.equal(summary.partial, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.scanned, 3);
  });

  it("passes the run's remaining budget through, letting classifyFeedItem pick the right path default", async () => {
    // NOT `itemTimeoutMs` pre-capped to the short-path constant — that would
    // silently starve a chunked item of the larger budget it needs, since the
    // drain cannot know in advance whether an item needs chunking.
    const items = [item("a")];
    const seen: unknown[] = [];
    const deps: ClassifyFeedItemsDeps = {
      findCandidates: async () => items,
      loadContext: async () => SCOPED,
      classify: async (_item, _ctx, opts) => {
        seen.push(opts);
        return { status: "skipped", reason: "unchanged" };
      },
    };
    await classifyFeedItems({ companyId: "co-1", remainingMs: () => 45_000 }, deps);
    assert.deepEqual(seen[0], { remainingRunBudgetMs: 45_000 });
  });
});

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

  /**
   * A shape assertion (above) proves the filter is WORDED correctly; it proves
   * nothing about which rows it actually admits — the classic trap that let a
   * nullable-column `in` clause silently drop an entire tier elsewhere in this
   * codebase (bug-1318). This interprets the REAL `where` object returned by
   * `classificationEligibleWhere` against realistic rows instead, so a future
   * edit that weakens the fragment fails here even if it still "looks right"
   * by eye. `interpret` is a small generic matcher for the handful of Prisma
   * operators this fragment actually uses (equality, `in`, `lt`, `AND`, `OR`,
   * and a nested relation object) — not a Prisma re-implementation.
   *
   * The rows model the shape a CHUNKED translation takes while still in
   * progress: `pending` with partial chunks already banked in
   * `translationProgress` (more cross-run attempts remain — see
   * translate-feed-item.service.ts), and `translating` (a claim is live right
   * now). Neither may ever reach the classifier — the article is still
   * changing which text it will read. `translationProgress` itself is not a
   * field this `where` names at all; it is included on the rows only to show
   * WHY those two statuses are dangerous; the exclusion happens purely on
   * `translationStatus`.
   */
  it("never admits a feed item whose chunked translation is still in progress", () => {
    const now = new Date("2026-08-18T12:00:00Z");
    const where = classificationEligibleWhere(now);

    type Row = Record<string, unknown>;

    // Evaluates one Prisma-style filter object against a flat row. Handles
    // exactly the shapes classificationEligibleWhere/classificationSelectableWhere
    // produce: scalar equality, `{ in: [...] }` (never matches null/undefined,
    // deliberately — Prisma's own semantics, and the trap bug-1318 was about),
    // `{ lt: number | Date }`, `AND`/`OR` arrays, and a nested relation filter
    // (`source: { enabled, type }`) matched key-by-key against a same-named
    // nested object on the row.
    function interpret(filter: Record<string, unknown>, row: Row): boolean {
      return Object.entries(filter).every(([key, expected]) => {
        if (key === "AND") {
          return (expected as Record<string, unknown>[]).every((f) => interpret(f, row));
        }
        if (key === "OR") {
          return (expected as Record<string, unknown>[]).some((f) => interpret(f, row));
        }
        const actual = row[key];
        if (expected !== null && typeof expected === "object" && !(expected instanceof Date)) {
          const cond = expected as Record<string, unknown>;
          if ("in" in cond) {
            const list = cond.in as unknown[];
            return actual !== null && actual !== undefined && list.includes(actual);
          }
          if ("lt" in cond) {
            // Works for both a number (classificationAttemptCount) and a Date
            // (classificationLeaseExpiresAt) — `<` compares Dates by their
            // underlying timestamp.
            return (actual as number | Date) < (cond.lt as number | Date);
          }
          // A nested relation filter (`source: { enabled, type }`): every key
          // inside it must equal the same key on the row's nested object.
          return interpret(cond, (actual as Row) ?? {});
        }
        return actual === expected;
      });
    }

    type ScenarioRow = {
      label: string;
      row: Row;
      /** Present only to document WHY the row is dangerous — not read by `interpret`. */
      translationProgress?: Record<string, string> | null;
      expectedEligible: boolean;
    };

    const scenarios: ScenarioRow[] = [
      {
        label: "mid-chunk, more attempts remain (translationProgress banked)",
        row: {
          usedInPost: false,
          source: { enabled: true, type: "rss" },
          translationStatus: "pending",
          classificationStatus: "pending",
          classificationAttemptCount: 0,
          classificationLeaseExpiresAt: null,
        },
        translationProgress: { "0": "first chunk done", "1": "second chunk done" },
        expectedEligible: false,
      },
      {
        label: "a chunk is being translated RIGHT NOW",
        row: {
          usedInPost: false,
          source: { enabled: true, type: "rss" },
          translationStatus: "translating",
          classificationStatus: "pending",
          classificationAttemptCount: 0,
          classificationLeaseExpiresAt: null,
        },
        translationProgress: { "0": "first chunk done" },
        expectedEligible: false,
      },
      {
        label: "every chunk succeeded and was reassembled",
        row: {
          usedInPost: false,
          source: { enabled: true, type: "rss" },
          translationStatus: "completed",
          classificationStatus: "pending",
          classificationAttemptCount: 0,
          classificationLeaseExpiresAt: null,
        },
        translationProgress: null,
        expectedEligible: true,
      },
      {
        label:
          "translation permanently gave up (attempt budget exhausted) — classify on whatever text exists",
        row: {
          usedInPost: false,
          source: { enabled: true, type: "rss" },
          translationStatus: "failed",
          classificationStatus: "pending",
          classificationAttemptCount: 0,
          classificationLeaseExpiresAt: null,
        },
        translationProgress: null,
        expectedEligible: true,
      },
      {
        label: "translation does not apply to this item at all",
        row: {
          usedInPost: false,
          source: { enabled: true, type: "rss" },
          translationStatus: null,
          classificationStatus: "pending",
          classificationAttemptCount: 0,
          classificationLeaseExpiresAt: null,
        },
        translationProgress: null,
        expectedEligible: true,
      },
      {
        label: "a live classification claim (lease not yet expired) is not re-picked",
        row: {
          usedInPost: false,
          source: { enabled: true, type: "rss" },
          translationStatus: "completed",
          classificationStatus: "classifying",
          classificationAttemptCount: 0,
          classificationLeaseExpiresAt: new Date(now.getTime() + 60_000),
        },
        translationProgress: null,
        expectedEligible: false,
      },
      {
        label: "the classification attempt budget is spent",
        row: {
          usedInPost: false,
          source: { enabled: true, type: "rss" },
          translationStatus: "completed",
          classificationStatus: "failed",
          classificationAttemptCount: MAX_CLASSIFICATION_ATTEMPTS,
          classificationLeaseExpiresAt: null,
        },
        translationProgress: null,
        expectedEligible: false,
      },
    ];

    for (const { label, row, expectedEligible } of scenarios) {
      assert.equal(interpret(where, row), expectedEligible, label);
    }
  });
});
