import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  claimFeedItem,
  planDirectContentSource,
  planFeedItemUsage,
  releaseFeedItem,
  type FeedItemReservationDb,
} from "./feed-item-reservation";

// ─── In-memory doubles ────────────────────────────────────────────────────────
//
// MockFeedItemDb models the feed_items table with the exact conditional-update
// semantics of Postgres: updateMany matches rows by (id, used_in_post) and
// returns how many rows changed. JS is single-threaded, so each updateMany runs
// to completion without interleaving — precisely the atomicity a single SQL
// `UPDATE ... WHERE id = ? AND used_in_post = ?` provides.

class MockFeedItemDb implements FeedItemReservationDb {
  private used: Map<string, boolean>;

  constructor(ids: string[], usedIds: string[] = []) {
    this.used = new Map(ids.map((id) => [id, usedIds.includes(id)]));
  }

  isUsed(id: string): boolean | undefined {
    return this.used.get(id);
  }

  feedItem = {
    updateMany: async (args: {
      where: { id: string; usedInPost: boolean };
      data: { usedInPost: boolean };
    }): Promise<{ count: number }> => {
      const current = this.used.get(args.where.id);
      if (current === undefined) return { count: 0 }; // no such row
      if (current !== args.where.usedInPost) return { count: 0 }; // WHERE unmatched
      this.used.set(args.where.id, args.data.usedInPost);
      return { count: 1 };
    },
  };
}

// Models the DB unique index on posts.primary_feed_item_id: a non-null feed item
// id can back only one post; NULL (mission/brand posts) is always allowed.
class MockPostDb {
  private seq = 0;
  private takenPrimary = new Set<string>();
  posts: Array<{ id: string; primaryFeedItemId: string | null }> = [];

  create = async (data: {
    primaryFeedItemId: string | null;
  }): Promise<{ id: string; primaryFeedItemId: string | null }> => {
    if (data.primaryFeedItemId !== null) {
      if (this.takenPrimary.has(data.primaryFeedItemId)) {
        throw new Error("Unique constraint failed: posts_primary_feed_item_id_key");
      }
      this.takenPrimary.add(data.primaryFeedItemId);
    }
    const post = { id: `post-${++this.seq}`, primaryFeedItemId: data.primaryFeedItemId };
    this.posts.push(post);
    return post;
  };
}

type SimResult =
  | { outcome: "created"; postId: string; primaryFeedItemId: string | null }
  | { outcome: "skipped" }
  | { outcome: "failed" };

// Mirrors generatePostFromContext's real ordering: claim a source article →
// (generate) → persist the post with primaryFeedItemId, releasing the claim if
// generation fails before persistence. Empty candidate list = mission post.
async function simulateGeneration(
  candidateIds: string[],
  feedDb: MockFeedItemDb,
  postDb: MockPostDb,
  opts: { failBeforePersist?: boolean } = {}
): Promise<SimResult> {
  let claimedId: string | null = null;
  if (candidateIds.length > 0) {
    claimedId = await claimFeedItem(candidateIds, feedDb);
    if (!claimedId) return { outcome: "skipped" };
  }
  if (opts.failBeforePersist) {
    if (claimedId) await releaseFeedItem(claimedId, feedDb);
    return { outcome: "failed" };
  }
  const post = await postDb.create({ primaryFeedItemId: claimedId });
  return { outcome: "created", postId: post.id, primaryFeedItemId: post.primaryFeedItemId };
}

// ─── 1. Used items are excluded ───────────────────────────────────────────────

describe("claimFeedItem — excludes used items", () => {
  it("skips an already-used candidate and claims the next free one", async () => {
    const db = new MockFeedItemDb(["A", "B"], ["A"]);
    const claimed = await claimFeedItem(["A", "B"], db);

    assert.strictEqual(claimed, "B", "should skip used A and claim free B");
    assert.strictEqual(db.isUsed("A"), true, "A stays used");
    assert.strictEqual(db.isUsed("B"), true, "B is now used");
  });
});

// ─── 2. First claim succeeds ──────────────────────────────────────────────────

describe("claimFeedItem — first claim succeeds", () => {
  it("claims a free item and marks it used", async () => {
    const db = new MockFeedItemDb(["A"]);
    const claimed = await claimFeedItem(["A"], db);

    assert.strictEqual(claimed, "A");
    assert.strictEqual(db.isUsed("A"), true);
  });
});

// ─── 3. Second claim of the same item fails ───────────────────────────────────

describe("claimFeedItem — second claim fails", () => {
  it("returns null when the only candidate is already claimed", async () => {
    const db = new MockFeedItemDb(["A"]);
    const first = await claimFeedItem(["A"], db);
    const second = await claimFeedItem(["A"], db);

    assert.strictEqual(first, "A");
    assert.strictEqual(second, null, "the same item cannot be claimed twice");
  });
});

// ─── 4. Contention tries the next item ────────────────────────────────────────

describe("claimFeedItem — contention falls through to the next candidate", () => {
  it("two sequential generations claim two different items", async () => {
    const db = new MockFeedItemDb(["A", "B"]);
    const first = await claimFeedItem(["A", "B"], db);
    const second = await claimFeedItem(["A", "B"], db);

    assert.strictEqual(first, "A", "first takes the highest-priority item");
    assert.strictEqual(second, "B", "second falls through to the next free item");
  });
});

// ─── 5. Successful post stores primaryFeedItemId ──────────────────────────────

describe("simulateGeneration — persists the claimed primaryFeedItemId", () => {
  it("stores the reserved feed item id on the created post", async () => {
    const feedDb = new MockFeedItemDb(["A", "B"]);
    const postDb = new MockPostDb();

    const result = await simulateGeneration(["A", "B"], feedDb, postDb);

    assert.strictEqual(result.outcome, "created");
    assert.ok(result.outcome === "created");
    assert.strictEqual(result.primaryFeedItemId, "A");
    assert.strictEqual(postDb.posts[0].primaryFeedItemId, "A");
    assert.strictEqual(feedDb.isUsed("A"), true);
  });

  it("a mission post (no feed items) persists with a null primaryFeedItemId", async () => {
    const feedDb = new MockFeedItemDb([]);
    const postDb = new MockPostDb();

    const result = await simulateGeneration([], feedDb, postDb);

    assert.ok(result.outcome === "created");
    assert.strictEqual(result.primaryFeedItemId, null);
  });
});

// ─── 6. Failure releases the item ─────────────────────────────────────────────

describe("simulateGeneration — releases the claim on failure", () => {
  it("frees the item so a later generation can reuse it", async () => {
    const feedDb = new MockFeedItemDb(["A"]);
    const postDb = new MockPostDb();

    const failed = await simulateGeneration(["A"], feedDb, postDb, { failBeforePersist: true });
    assert.strictEqual(failed.outcome, "failed");
    assert.strictEqual(feedDb.isUsed("A"), false, "the item is released after a failure");

    // The freed item is claimable again and now persists.
    const retry = await simulateGeneration(["A"], feedDb, postDb);
    assert.ok(retry.outcome === "created");
    assert.strictEqual(retry.primaryFeedItemId, "A");
  });
});

// ─── 7. No available item skips cleanly ───────────────────────────────────────

describe("simulateGeneration — no candidates skips cleanly", () => {
  it("returns skipped (not an error) and creates no post", async () => {
    const feedDb = new MockFeedItemDb(["A"], ["A"]); // only item already used
    const postDb = new MockPostDb();

    const result = await simulateGeneration(["A"], feedDb, postDb);

    assert.strictEqual(result.outcome, "skipped");
    assert.strictEqual(postDb.posts.length, 0, "no post is created when nothing can be claimed");
  });
});

// ─── 8. Concurrent attempts cannot use the same FeedItem ──────────────────────

describe("claimFeedItem — concurrency", () => {
  it("two concurrent claims on one item yield exactly one winner", async () => {
    const db = new MockFeedItemDb(["A"]);

    const [r1, r2] = await Promise.all([claimFeedItem(["A"], db), claimFeedItem(["A"], db)]);

    const winners = [r1, r2].filter((r) => r === "A");
    const losers = [r1, r2].filter((r) => r === null);
    assert.strictEqual(winners.length, 1, "exactly one claim wins the item");
    assert.strictEqual(losers.length, 1, "exactly one claim is refused");
  });

  it("two concurrent generations on a two-item pool take different items", async () => {
    const feedDb = new MockFeedItemDb(["A", "B"]);
    const postDb = new MockPostDb();

    const [r1, r2] = await Promise.all([
      simulateGeneration(["A", "B"], feedDb, postDb),
      simulateGeneration(["A", "B"], feedDb, postDb),
    ]);

    assert.ok(r1.outcome === "created" && r2.outcome === "created");
    const ids = [r1.primaryFeedItemId, r2.primaryFeedItemId].sort();
    assert.deepStrictEqual(ids, ["A", "B"], "the two posts use distinct feed items");
  });
});

// ─── 9. Database uniqueness prevents duplicate usage ──────────────────────────

describe("post uniqueness backstop", () => {
  it("a second post for the same feed item is rejected by the unique index", async () => {
    const postDb = new MockPostDb();

    await postDb.create({ primaryFeedItemId: "A" });
    await assert.rejects(
      () => postDb.create({ primaryFeedItemId: "A" }),
      /Unique constraint failed: posts_primary_feed_item_id_key/,
      "the DB unique index is the backstop even if the boolean claim ever raced"
    );
  });

  it("mission posts with null primaryFeedItemId are never blocked", async () => {
    const postDb = new MockPostDb();

    await postDb.create({ primaryFeedItemId: null });
    await postDb.create({ primaryFeedItemId: null });
    assert.strictEqual(postDb.posts.length, 2, "multiple null-source posts are allowed");
  });
});

// ─── 10. Empty-feed disambiguation (no sources vs. sources exhausted) ─────────

describe("planFeedItemUsage — four-way source decision", () => {
  it("no sources of any kind → mission post (no claim, no skip)", async () => {
    const db = new MockFeedItemDb([]);
    const plan = await planFeedItemUsage(
      [],
      /* hasArticleSources */ false,
      /* evergreen */ false,
      db
    );

    assert.deepStrictEqual(plan, { action: "mission" });
  });

  it("article sources exist but no eligible unused items → skip cleanly", async () => {
    // The company has RSS configured, but every article is already used, so the
    // candidate window is empty. This must NOT fall back to a mission post.
    const db = new MockFeedItemDb(["A"], ["A"]);
    const candidates: string[] = []; // builder returns 0 unused article items
    const plan = await planFeedItemUsage(candidates, /* hasArticleSources */ true, false, db);

    assert.deepStrictEqual(plan, { action: "skip" });
  });

  it("eligible unused article items → claim one and generate", async () => {
    const db = new MockFeedItemDb(["A", "B"]);
    const plan = await planFeedItemUsage(["A", "B"], /* hasArticleSources */ true, false, db);

    assert.deepStrictEqual(plan, { action: "generate", feedItemId: "A" });
    assert.strictEqual(db.isUsed("A"), true, "the claimed item is marked used");
    assert.strictEqual(db.isUsed("B"), false, "the untouched item stays free");
  });

  it("article candidates present but all raced away → skip, not mission", async () => {
    // hasArticleSources is true and candidate ids were passed, but each was
    // claimed by a concurrent run between context build and claim.
    const db = new MockFeedItemDb(["A"], ["A"]);
    const plan = await planFeedItemUsage(["A"], /* hasArticleSources */ true, false, db);

    assert.deepStrictEqual(plan, { action: "skip" });
  });

  // ── Evergreen (prompt/calendar) — reusable, never claimed ──────────────────

  it("evergreen item, no article source → evergreen (no claim)", async () => {
    // A prompt-only company: no article candidates, no article sources, but a
    // reusable evergreen item is available. Must generate, not fall to mission.
    const db = new MockFeedItemDb([]);
    const plan = await planFeedItemUsage(
      [],
      /* hasArticleSources */ false,
      /* evergreen */ true,
      db
    );

    assert.deepStrictEqual(plan, { action: "evergreen" });
  });

  it("exhausted article source + evergreen item → evergreen (not skip)", async () => {
    // Mixed company: RSS is exhausted (empty article window) but a prompt item
    // remains. The prompt keeps the company generating instead of skipping.
    const db = new MockFeedItemDb([]);
    const plan = await planFeedItemUsage(
      [],
      /* hasArticleSources */ true,
      /* evergreen */ true,
      db
    );

    assert.deepStrictEqual(plan, { action: "evergreen" });
  });

  it("article candidate present alongside evergreen → article wins (claims it)", async () => {
    const db = new MockFeedItemDb(["A"]);
    const plan = await planFeedItemUsage(
      ["A"],
      /* hasArticleSources */ true,
      /* evergreen */ true,
      db
    );

    assert.deepStrictEqual(plan, { action: "generate", feedItemId: "A" });
    assert.strictEqual(db.isUsed("A"), true, "the article is still consumed");
  });

  it("article candidates all raced but evergreen present → evergreen, not skip", async () => {
    const db = new MockFeedItemDb(["A"], ["A"]);
    const plan = await planFeedItemUsage(
      ["A"],
      /* hasArticleSources */ true,
      /* evergreen */ true,
      db
    );

    assert.deepStrictEqual(plan, { action: "evergreen" });
  });
});

// ─── planDirectContentSource ──────────────────────────────────────────────────

describe("planDirectContentSource", () => {
  it("generates directly when the source has stored content", () => {
    assert.deepStrictEqual(planDirectContentSource([{ id: "pp-1" }]), { action: "direct" });
  });

  it("skips when nothing has been extracted for the source", () => {
    // The window is already scoped to the one picked source, so empty means the
    // source has never been fetched — the manual flow reports that rather than
    // drifting to another source or to a mission post.
    assert.deepStrictEqual(planDirectContentSource([]), { action: "skip" });
  });

  it("is repeatable — the same source keeps planning the same way", () => {
    // The bug this path exists to prevent: routing a product page through the
    // reservation consumes its single stored row and leaves the source
    // permanently dry. Nothing here consumes, so the second ask answers like the
    // first. (It takes no db at all — there is no row it could mark used.)
    const items = [{ id: "pp-1" }];
    assert.deepStrictEqual(planDirectContentSource(items), planDirectContentSource(items));
    assert.deepStrictEqual(planDirectContentSource(items), { action: "direct" });
  });
});
