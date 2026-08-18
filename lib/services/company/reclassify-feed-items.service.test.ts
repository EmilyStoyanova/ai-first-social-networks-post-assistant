import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  RECLASSIFY_REOPEN_DATA,
  reclassifiableWhere,
  reclassifyAfterTopicChange,
  reclassifyCompanyFeedItems,
  requestReclassification,
  topicPrioritiesChanged,
} from "./reclassify-feed-items.service";
import { MAX_CLASSIFICATION_ATTEMPTS } from "@/lib/ai/feed-item-classification";
import { resolveTopicPriorities } from "@/lib/ai/topic-priorities";
import type { EnqueueJobResult } from "@/lib/services/queue/enqueue-job.service";

const ENQUEUED: EnqueueJobResult = { enqueued: true, deduplicated: false, jobId: "job-1" };
const DEDUPED: EnqueueJobResult = { enqueued: false, deduplicated: true, jobId: "job-0" };

function makeDeps(opts: { reopened?: number; enqueue?: EnqueueJobResult } = {}) {
  const calls = { reopen: 0, enqueue: 0, scopes: [] as Array<string | null> };
  return {
    calls,
    deps: {
      reopen: async (_companyId: string, sourceId: string | null) => {
        calls.reopen += 1;
        calls.scopes.push(sourceId);
        return opts.reopened ?? 0;
      },
      enqueue: async () => {
        calls.enqueue += 1;
        return opts.enqueue ?? ENQUEUED;
      },
    },
  };
}

// ─── Reading the predicate as behaviour, not as a shape ───────────────────────

/**
 * A stored article, in just the columns the predicate looks at.
 */
interface Row {
  companyId: string;
  sourceId: string;
  usedInPost: boolean;
  classificationStatus: string | null;
  source: { enabled: boolean; type: string };
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    companyId: "co-1",
    sourceId: "src-a",
    usedInPost: false,
    classificationStatus: "completed",
    source: { enabled: true, type: "rss" },
    ...overrides,
  };
}

/**
 * Runs a `reclassifiableWhere` fragment against a row the way Prisma would.
 *
 * Interpreted rather than shape-asserted, because the bug this file was written
 * for was invisible to a shape assertion: a perfectly well-formed `{ in: [...] }`
 * that simply never matched NULL. A test that reads keys back out of the object
 * agrees with whatever the object says; only rows can disagree with it.
 */
function matchesWhere(where: Record<string, unknown>, item: Row): boolean {
  if (where.companyId !== item.companyId) return false;
  if ("sourceId" in where && where.sourceId !== item.sourceId) return false;
  if (where.usedInPost !== item.usedInPost) return false;

  const source = where.source as { enabled: boolean; type: string };
  if (source.enabled !== item.source.enabled) return false;
  if (source.type !== item.source.type) return false;

  const alternatives = where.OR as Array<Record<string, unknown>>;
  return alternatives.some((alt) => {
    const clause = alt.classificationStatus;
    // Prisma's `in` compares values and NEVER matches NULL.
    if (clause !== null && typeof clause === "object") {
      const list = (clause as { in?: unknown[] }).in;
      return item.classificationStatus !== null && !!list?.includes(item.classificationStatus);
    }
    return clause === item.classificationStatus;
  });
}

// ─── Which articles may be reopened ───────────────────────────────────────────

describe("reclassifiableWhere", () => {
  const where = reclassifiableWhere("co-1");

  /**
   * The status alternatives, read back out of the predicate.
   *
   * `matchesStatus` is what the tests below actually assert against, because the
   * bug this file guards was invisible to a shape assertion: the old predicate was
   * a perfectly well-formed `{ in: [...] }` that simply never matched NULL.
   */
  const alternatives = where.OR as Array<Record<string, unknown>>;

  function matchesStatus(status: string | null): boolean {
    return alternatives.some((alt) => {
      const clause = alt.classificationStatus;
      if (clause === null) return status === null;
      const list = (clause as { in?: string[] }).in;
      return status !== null && Array.isArray(list) && list.includes(status);
    });
  }

  it("never reopens a CONSUMED article — history stays as it was decided", () => {
    // A verdict on an article a post was already written from recorded a
    // decision made under the configuration in force at the time. Rewriting it
    // would make the post's own record disagree with itself.
    assert.equal(where.usedInPost, false);
  });

  it("only covers enabled RSS sources", () => {
    // The real expression of "the feature does not apply to this row": a
    // product_page or calendar item is never reopened, whatever its status.
    assert.deepEqual(where.source, { enabled: true, type: "rss" });
  });

  it("reopens every settled row", () => {
    for (const status of ["completed", "skipped", "failed"]) {
      assert.equal(matchesStatus(status), true, `${status} must be reopenable`);
    }
  });

  it("never reopens a row already queued or in flight behind a live lease", () => {
    // `pending` is already queued and `classifying` sits behind a live lease;
    // touching either would yank an item out from under a running drain.
    assert.equal(matchesStatus("pending"), false);
    assert.equal(matchesStatus("classifying"), false);
  });

  /**
   * REGRESSION — the exact production failure.
   *
   * The classification columns shipped nullable and unbackfilled, so every RSS
   * article ingested before 20260817140000_add_feed_item_classification carries
   * `classificationStatus = null`. The drain cannot see such a row either
   * (`classificationSelectableWhere` matches pending/failed/expired-classifying
   * only), and the sole path that ever set a status on one was a re-ingest of its
   * own URL — impossible once the article has scrolled out of the feed window.
   *
   * Family Handyman: 15 of 21 permanently "Unclassified" articles were exactly
   * this — enabled, unconsumed, translated, with a readable body, and untouchable
   * by every path in the system including the Reclassify button.
   */
  it("reopens a legacy row that never received a status at all", () => {
    assert.equal(
      matchesStatus(null),
      true,
      "a null classificationStatus on an enabled RSS source is 'never asked', not 'does not apply'"
    );
  });

  it("names null as its own alternative rather than putting it in an `in` list", () => {
    // Prisma's `in` matches values and never NULL, so `in: [..., null]` would
    // silently reproduce the bug while looking like the fix.
    for (const alt of alternatives) {
      const list = (alt.classificationStatus as { in?: unknown[] } | null)?.in;
      if (Array.isArray(list)) assert.equal(list.includes(null), false);
    }
  });

  it("is scoped to the one company", () => {
    assert.equal(where.companyId, "co-1");
  });

  it("keeps the status alternatives as the predicate's only OR", () => {
    // The reopen runs this object as a single Prisma `where`; a second top-level
    // OR would silently replace this one and reopen far more than intended.
    assert.equal(Object.keys(where).filter((k) => k === "OR").length, 1);
    assert.deepEqual(Object.keys(where).sort(), ["OR", "companyId", "source", "usedInPost"]);
  });

  it("covers the whole company when no source is named", () => {
    // The Brand Settings hook passes no source: a topic change applies to every
    // feed the company reads, so scoping it to one would leave the rest stale.
    assert.equal("sourceId" in where, false);
    assert.equal(matchesWhere(where, row({ sourceId: "src-a" })), true);
    assert.equal(matchesWhere(where, row({ sourceId: "src-b" })), true);
  });
});

// ─── The per-source button ────────────────────────────────────────────────────

describe("reclassifiableWhere, scoped to one source", () => {
  const where = reclassifiableWhere("co-1", "src-a");

  /**
   * THE POINT OF THIS CHANGE.
   *
   * The button is drawn inside one source's card but used to reopen every
   * eligible article the company owned. Somebody pressing it on a feed of 20
   * articles got back a count in the hundreds, and no way to tell which list it
   * referred to.
   */
  it("reopens only the named source's articles", () => {
    assert.equal(matchesWhere(where, row({ sourceId: "src-a" })), true);
  });

  it("leaves another RSS source of the SAME company untouched", () => {
    // Same company, same type, equally eligible in every other respect — the
    // source id is the only thing keeping it out.
    assert.equal(
      matchesWhere(where, row({ sourceId: "src-b" })),
      false,
      "a sibling feed must not be reopened by a button pressed on this one"
    );
  });

  it("cannot reach another company's rows even at the same source id", () => {
    // Belt and braces: the caller has already checked ownership, but companyId
    // stays in the predicate so a mistake there still cannot cross tenants.
    assert.equal(matchesWhere(where, row({ companyId: "co-2" })), false);
  });

  it("still never reopens a CONSUMED article", () => {
    assert.equal(matchesWhere(where, row({ usedInPost: true })), false);
  });

  it("still reopens a legacy row that never received a status at all", () => {
    // The 15 Family Handyman articles: enabled, unconsumed, and invisible to
    // every other path in the system.
    assert.equal(matchesWhere(where, row({ classificationStatus: null })), true);
  });

  it("still reopens every settled status and no live one", () => {
    for (const status of ["completed", "skipped", "failed"]) {
      assert.equal(matchesWhere(where, row({ classificationStatus: status })), true, status);
    }
    for (const status of ["pending", "classifying"]) {
      assert.equal(matchesWhere(where, row({ classificationStatus: status })), false, status);
    }
  });

  it("still ignores a disabled or non-RSS source", () => {
    assert.equal(matchesWhere(where, row({ source: { enabled: false, type: "rss" } })), false);
    assert.equal(
      matchesWhere(where, row({ source: { enabled: true, type: "product_page" } })),
      false
    );
  });

  /**
   * What the button REPORTS. `reopened` is rendered straight into "N articles
   * from this source queued", above a list showing that same source — so a count
   * that included a sibling feed would be visibly, unfixably wrong.
   */
  it("counts only the named source", () => {
    const feed: Row[] = [
      row({ sourceId: "src-a", classificationStatus: "completed" }),
      row({ sourceId: "src-a", classificationStatus: null }),
      row({ sourceId: "src-a", classificationStatus: "failed" }),
      row({ sourceId: "src-a", usedInPost: true }), // consumed — never
      row({ sourceId: "src-a", classificationStatus: "pending" }), // already queued
      row({ sourceId: "src-b", classificationStatus: "completed" }), // sibling feed
      row({ sourceId: "src-b", classificationStatus: null }),
      row({ companyId: "co-2", sourceId: "src-a" }), // another tenant
    ];

    assert.equal(feed.filter((r) => matchesWhere(where, r)).length, 3);
    // And the unscoped predicate is what the company-wide caller still gets.
    assert.equal(feed.filter((r) => matchesWhere(reclassifiableWhere("co-1"), r)).length, 5);
  });
});

// ─── What a reopen writes ─────────────────────────────────────────────────────

describe("RECLASSIFY_REOPEN_DATA", () => {
  it("queues the row", () => {
    assert.equal(RECLASSIFY_REOPEN_DATA.classificationStatus, "pending");
  });

  /**
   * REGRESSION — "reopened on paper, unreachable in fact".
   *
   * A row that spent its retry budget against the old configuration comes back
   * `pending`; if its attempt count came back too, the drain's own
   * `classificationAttemptCount < MAX` filter would refuse it forever and the
   * button would report rows reopened that nothing can ever classify.
   */
  it("gives a row that exhausted its retries a fresh budget", () => {
    assert.equal(RECLASSIFY_REOPEN_DATA.classificationAttemptCount, 0);
    assert.ok(
      RECLASSIFY_REOPEN_DATA.classificationAttemptCount < MAX_CLASSIFICATION_ATTEMPTS,
      "a reopened row must be selectable by the drain's attempt filter"
    );
  });

  it("clears the stale error and any dead lease", () => {
    assert.equal(RECLASSIFY_REOPEN_DATA.classificationError, null);
    assert.equal(RECLASSIFY_REOPEN_DATA.classificationLeaseExpiresAt, null);
  });

  it("never writes a verdict — a reopen asks the question, it does not answer it", () => {
    // A failure must never silently become REJECTED, and a reopen must never
    // fabricate one either.
    const keys = Object.keys(RECLASSIFY_REOPEN_DATA);
    assert.equal(keys.includes("classification"), false);
    assert.equal(keys.includes("classificationRejectionReason"), false);
    // The hash is left alone on purpose: it is what lets an item whose text and
    // topics did not really change settle back without a model call.
    assert.equal(keys.includes("classificationHash"), false);
  });
});

// ─── Does a settings change warrant any work at all? ──────────────────────────

describe("topicPrioritiesChanged", () => {
  const base = resolveTopicPriorities({
    topPriorityTopics: ["бои", "бойлери"],
    mediumPriorityTopics: ["вентилация"],
    avoidedTopics: ["камини"],
  });

  it("is false for an identical configuration", () => {
    assert.equal(topicPrioritiesChanged(base, base), false);
  });

  it("is false when only the order or casing changed", () => {
    // Saving Brand Settings without touching topics, or re-typing one with
    // different capitalisation, must not reopen a whole feed.
    const reordered = resolveTopicPriorities({
      topPriorityTopics: ["Бойлери", "БОИ"],
      mediumPriorityTopics: ["Вентилация"],
      avoidedTopics: ["камини"],
    });
    assert.equal(topicPrioritiesChanged(base, reordered), false);
  });

  it("is true when a topic is added", () => {
    const added = resolveTopicPriorities({
      topPriorityTopics: ["бои", "бойлери", "смесители"],
      mediumPriorityTopics: ["вентилация"],
      avoidedTopics: ["камини"],
    });
    assert.equal(topicPrioritiesChanged(base, added), true);
  });

  it("is true when a topic moves between groups", () => {
    const moved = resolveTopicPriorities({
      topPriorityTopics: ["бои"],
      mediumPriorityTopics: ["вентилация", "бойлери"],
      avoidedTopics: ["камини"],
    });
    assert.equal(topicPrioritiesChanged(base, moved), true);
  });

  it("is true when topics are configured for the first time", () => {
    const none = resolveTopicPriorities(null);
    assert.equal(topicPrioritiesChanged(none, base), true);
  });
});

// ─── The shared reopen + enqueue path ─────────────────────────────────────────

describe("reclassifyCompanyFeedItems", () => {
  it("enqueues the drain when rows were reopened", async () => {
    const { deps, calls } = makeDeps({ reopened: 7 });
    const result = await reclassifyCompanyFeedItems("co-1", deps);

    assert.equal(result.reopened, 7);
    assert.deepEqual(result.enqueued, ENQUEUED);
    assert.equal(calls.enqueue, 1);
  });

  it("reopens the whole company when no source is named", async () => {
    const { deps, calls } = makeDeps({ reopened: 7 });
    await reclassifyCompanyFeedItems("co-1", deps);
    assert.deepEqual(calls.scopes, [null], "null scope is 'every source'");
  });

  it("reopens only the named source when one is given", async () => {
    const { deps, calls } = makeDeps({ reopened: 7 });
    await reclassifyCompanyFeedItems("co-1", deps, "src-a");
    assert.deepEqual(calls.scopes, ["src-a"]);
  });

  it("asks for no drain when nothing was stale", async () => {
    const { deps, calls } = makeDeps({ reopened: 0 });
    const result = await reclassifyCompanyFeedItems("co-1", deps);

    assert.deepEqual(result, { reopened: 0, enqueued: null });
    assert.equal(calls.enqueue, 0, "an empty reopen must not queue a pointless run");
  });

  it("is safe to run twice — the second enqueue is absorbed by the dedupe key", async () => {
    const { deps } = makeDeps({ reopened: 3, enqueue: DEDUPED });
    const first = await reclassifyCompanyFeedItems("co-1", deps);
    const second = await reclassifyCompanyFeedItems("co-1", deps);

    assert.equal(first.reopened, 3);
    assert.equal(second.reopened, 3);
    assert.equal(second.enqueued?.deduplicated, true);
  });
});

describe("reclassifyAfterTopicChange", () => {
  const before = resolveTopicPriorities({ topPriorityTopics: ["бои"] });
  const after = resolveTopicPriorities({ topPriorityTopics: ["бои", "бойлери"] });

  it("does nothing at all when the topics did not really change", async () => {
    const { deps, calls } = makeDeps({ reopened: 5 });
    const result = await reclassifyAfterTopicChange("co-1", before, before, deps);

    assert.equal(result, null);
    assert.equal(calls.reopen, 0, "no rows may be touched");
    assert.equal(calls.enqueue, 0);
  });

  it("reopens and enqueues when the topics changed", async () => {
    const { deps, calls } = makeDeps({ reopened: 12 });
    const result = await reclassifyAfterTopicChange("co-1", before, after, deps);

    assert.equal(result?.reopened, 12);
    assert.equal(calls.reopen, 1);
    assert.equal(calls.enqueue, 1);
    // Company-wide, and it must stay that way: a topic change applies to every
    // feed, so scoping this to a source would leave the others stale forever.
    assert.deepEqual(calls.scopes, [null]);
  });

  it("never lets a queue failure break the settings save", async () => {
    const deps = {
      reopen: async () => 4,
      enqueue: async () => {
        throw new Error("queue unreachable");
      },
    };
    const result = await reclassifyAfterTopicChange("co-1", before, after, deps);
    assert.equal(result, null, "swallowed — the save has already succeeded");
  });
});

// ─── The manual action ────────────────────────────────────────────────────────

describe("requestReclassification", () => {
  const allow = async () => ({ ok: true, companyId: "co-1" }) as const;
  const owns = async () => true;

  it("reopens and queues for an authorized caller", async () => {
    const { deps, calls } = makeDeps({ reopened: 9 });
    const result = await requestReclassification("acme", "src-a", "user-1", false, {
      ...deps,
      resolveAccess: allow,
      sourceBelongsToCompany: owns,
    });

    assert.equal(result.success, true);
    assert.ok(result.success);
    assert.equal(result.reopened, 9);
    assert.equal(result.enqueued, true);
    assert.equal(calls.enqueue, 1);
  });

  it("passes the clicked source down as the scope of the reopen", async () => {
    // The whole contract in one assertion: the id from the URL is what reaches
    // the predicate, so the button cannot act outside the card it lives in.
    const { deps, calls } = makeDeps({ reopened: 3 });
    await requestReclassification("acme", "src-a", "user-1", false, {
      ...deps,
      resolveAccess: allow,
      sourceBelongsToCompany: owns,
    });

    assert.deepEqual(calls.scopes, ["src-a"]);
  });

  it("rejects a source belonging to another company and writes nothing", async () => {
    // NOT_FOUND rather than FORBIDDEN: an id out of a URL is guessable, and
    // "you may not touch that source" would confirm it exists.
    const { deps, calls } = makeDeps({ reopened: 9 });
    const result = await requestReclassification("acme", "src-of-other-co", "user-1", false, {
      ...deps,
      resolveAccess: allow,
      sourceBelongsToCompany: async () => false,
    });

    assert.equal(result.success === false && result.code, "NOT_FOUND");
    assert.equal(calls.reopen, 0, "an unowned source must leave every row as it was");
    assert.equal(calls.enqueue, 0);
  });

  it("checks ownership against the company the SLUG resolved to", async () => {
    const seen: Array<[string, string]> = [];
    const { deps } = makeDeps({ reopened: 1 });
    await requestReclassification("acme", "src-a", "user-1", false, {
      ...deps,
      resolveAccess: allow,
      sourceBelongsToCompany: async (companyId, sourceId) => {
        seen.push([companyId, sourceId]);
        return true;
      },
    });

    assert.deepEqual(seen, [["co-1", "src-a"]]);
  });

  it("refuses an editor and touches nothing", async () => {
    const { deps, calls } = makeDeps({ reopened: 9 });
    const result = await requestReclassification("acme", "src-a", "editor-1", false, {
      ...deps,
      resolveAccess: async () => ({ ok: false, code: "FORBIDDEN" }) as const,
      sourceBelongsToCompany: owns,
    });

    assert.equal(result.success, false);
    assert.equal(result.success === false && result.code, "FORBIDDEN");
    assert.equal(calls.reopen, 0);
    assert.equal(calls.enqueue, 0);
  });

  it("gives a non-member NOT_FOUND and touches nothing", async () => {
    const { deps, calls } = makeDeps({ reopened: 9 });
    const result = await requestReclassification("acme", "src-a", "outsider", false, {
      ...deps,
      resolveAccess: async () => ({ ok: false, code: "NOT_FOUND" }) as const,
      sourceBelongsToCompany: owns,
    });

    assert.equal(result.success === false && result.code, "NOT_FOUND");
    assert.equal(calls.reopen, 0);
  });

  it("never checks a source before it has checked the caller", async () => {
    // Order matters: probing sources for a company you are not a member of is
    // exactly how an id gets confirmed by timing.
    let checkedSource = false;
    const { deps } = makeDeps({ reopened: 0 });
    await requestReclassification("acme", "src-a", "outsider", false, {
      ...deps,
      resolveAccess: async () => ({ ok: false, code: "NOT_FOUND" }) as const,
      sourceBelongsToCompany: async () => {
        checkedSource = true;
        return true;
      },
    });

    assert.equal(checkedSource, false);
  });

  it("always reopens, even when nothing obviously changed", async () => {
    // The button exists for what a fingerprint cannot see — a classification that
    // failed against a dead provider, or a verdict an operator distrusts.
    const { deps, calls } = makeDeps({ reopened: 0 });
    const result = await requestReclassification("acme", "src-a", "user-1", false, {
      ...deps,
      resolveAccess: allow,
      sourceBelongsToCompany: owns,
    });

    assert.equal(result.success, true);
    assert.equal(calls.reopen, 1);
  });

  it("reports zero rather than an error for a source with nothing stale", async () => {
    // A disabled or non-RSS source lands here too: the predicate excludes it, so
    // the action honestly reopens nothing instead of needing a special case.
    const { deps, calls } = makeDeps({ reopened: 0 });
    const result = await requestReclassification("acme", "src-a", "user-1", false, {
      ...deps,
      resolveAccess: allow,
      sourceBelongsToCompany: owns,
    });

    assert.ok(result.success);
    assert.equal(result.reopened, 0);
    assert.equal(calls.enqueue, 0, "no drain for an empty reopen");
  });
});
