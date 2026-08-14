import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deletePostCore,
  isPostExclusiveAsset,
  type DeletableMediaAsset,
  type DeletePostDeps,
} from "./delete-post.service";
import {
  createSemanticGate,
  type SemanticNeighborStore,
} from "@/lib/services/ai/semantic-gate.service";
import { checkDuplicatePost } from "@/lib/ai/quality/duplicate-detection";
import { EMBEDDING_DIMENSIONS } from "@/lib/ai/embedding/embedding-provider-factory";
import type { IEmbeddingProvider } from "@/lib/ai/embedding/embedding-provider";

const SLUG = "acme";
const COMPANY_ID = "company-1";
const OTHER_COMPANY_ID = "company-2";
const USER_ID = "user-1";
const POST_ID = "post-1";
const CHANNEL = "facebook" as const;

// ─── An in-memory stand-in for the tables this service touches ────────────────
// Deliberately dumb: rows in arrays, and deletes that remove exactly the rows the
// service asks for. Nothing here simulates ON DELETE CASCADE, so a child table
// the service forgets to name stays behind and the test fails — which is the
// whole point of deleting the children explicitly.

interface FakePost {
  id: string;
  companyId: string;
  channel: string;
  content: string;
  coreMessage: string | null;
  status: string;
  mediaAssetId: string | null;
  previousMediaAssetId: string | null;
  createdAt: Date;
}

interface FakeSemantics {
  postId: string;
  companyId: string;
  channel: string;
  status: string;
  vector: number[] | null;
  postCreatedAt: Date;
}

interface FakeDb {
  posts: FakePost[];
  semantics: FakeSemantics[];
  versions: Array<{ id: string; postId: string }>;
  metrics: Array<{ postId: string }>;
  snapshots: Array<{ postId: string }>;
  assets: DeletableMediaAsset[];
  auditLogs: Array<{ postId: string; deletedMediaAssetIds: string[]; orphaned: string[] }>;
  cloudinary: Set<string>;
}

/** A 1024-dim unit vector along axis `axis` — the dimension the gate enforces. */
function vec(axis: number): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  v[axis % EMBEDDING_DIMENSIONS] = 1;
  return v;
}

const AI_ASSET: DeletableMediaAsset = {
  id: "asset-ai",
  cloudinaryId: "cloud/ai-1",
  generatedBy: "ai",
  sourceUrl: null,
};
const ARTICLE_ASSET: DeletableMediaAsset = {
  id: "asset-article",
  cloudinaryId: "cloud/article-1",
  generatedBy: "user_upload",
  sourceUrl: "https://news.example.com/story.jpg",
};
const UPLOAD_ASSET: DeletableMediaAsset = {
  id: "asset-upload",
  cloudinaryId: "cloud/upload-1",
  generatedBy: "user_upload",
  sourceUrl: null,
};

function makeDb(overrides: Partial<FakeDb> = {}): FakeDb {
  return {
    posts: [
      {
        id: POST_ID,
        companyId: COMPANY_ID,
        channel: CHANNEL,
        content: "Our new roasting profile brings out the caramel notes in every cup.",
        coreMessage: "The new roast is sweeter.",
        status: "draft",
        mediaAssetId: null,
        previousMediaAssetId: null,
        createdAt: new Date("2026-08-10T09:00:00Z"),
      },
      {
        id: "post-keep",
        companyId: COMPANY_ID,
        channel: CHANNEL,
        content: "Meet the team behind the counter.",
        coreMessage: "Our baristas are the craft.",
        status: "draft",
        mediaAssetId: null,
        previousMediaAssetId: null,
        createdAt: new Date("2026-08-09T09:00:00Z"),
      },
    ],
    semantics: [
      {
        postId: POST_ID,
        companyId: COMPANY_ID,
        channel: CHANNEL,
        status: "ready",
        vector: vec(0),
        postCreatedAt: new Date("2026-08-10T09:00:00Z"),
      },
      {
        postId: "post-keep",
        companyId: COMPANY_ID,
        channel: CHANNEL,
        status: "ready",
        vector: vec(500),
        postCreatedAt: new Date("2026-08-09T09:00:00Z"),
      },
    ],
    versions: [
      { id: "v1", postId: POST_ID },
      { id: "v2", postId: POST_ID },
      { id: "v3", postId: "post-keep" },
    ],
    metrics: [{ postId: POST_ID }],
    snapshots: [{ postId: POST_ID }, { postId: POST_ID }],
    assets: [],
    auditLogs: [],
    cloudinary: new Set(["cloud/ai-1", "cloud/article-1", "cloud/upload-1"]),
    ...overrides,
  };
}

interface DepsOptions {
  role?: string | null;
  /** Company the acting user belongs to; the post is always in COMPANY_ID. */
  memberOf?: string;
  cloudinaryFails?: boolean;
  transactionFails?: boolean;
}

function makeDeps(db: FakeDb, options: DepsOptions = {}): DeletePostDeps {
  const role = options.role === undefined ? "owner" : options.role;
  const memberCompanyId = options.memberOf ?? COMPANY_ID;

  return {
    async loadAccess(_slug, _userId, isGlobalAdmin) {
      if (isGlobalAdmin) return { companyId: COMPANY_ID, canDelete: true };
      if (role === null) return null;
      return { companyId: memberCompanyId, canDelete: role === "owner" };
    },

    async loadPost(postId, companyId) {
      const post = db.posts.find((p) => p.id === postId && p.companyId === companyId);
      if (!post) return null;
      return {
        id: post.id,
        status: post.status,
        mediaAssetId: post.mediaAssetId,
        previousMediaAssetId: post.previousMediaAssetId,
      };
    },

    async loadMediaAssets(ids) {
      return db.assets.filter((a) => ids.includes(a.id));
    },

    async countOtherPostsUsing(assetId, excludingPostId) {
      return db.posts.filter(
        (p) =>
          p.id !== excludingPostId &&
          (p.mediaAssetId === assetId || p.previousMediaAssetId === assetId)
      ).length;
    },

    async deletePostAndOwnedRecords({ postId, mediaAssetIds }) {
      if (options.transactionFails) throw new Error("deadlock detected");
      db.semantics = db.semantics.filter((s) => s.postId !== postId);
      db.versions = db.versions.filter((v) => v.postId !== postId);
      db.snapshots = db.snapshots.filter((s) => s.postId !== postId);
      db.metrics = db.metrics.filter((m) => m.postId !== postId);
      db.posts = db.posts.filter((p) => p.id !== postId);
      db.assets = db.assets.filter((a) => !mediaAssetIds.includes(a.id));
    },

    async destroyCloudinaryAsset(cloudinaryId) {
      if (options.cloudinaryFails) return false;
      db.cloudinary.delete(cloudinaryId);
      return true;
    },

    async audit(input) {
      db.auditLogs.push({
        postId: input.postId,
        deletedMediaAssetIds: input.deletedMediaAssetIds,
        orphaned: input.orphanedCloudinaryIds,
      });
    },
  };
}

// ─── The duplicate-detection mechanisms, read from the same fixture ────────────

/** Mirrors the production SQL in semantic-gate.service: post_semantics JOIN posts. */
function semanticStoreOver(db: FakeDb): SemanticNeighborStore {
  return {
    async fetchReadyNeighbors(companyId, channel, limit) {
      return (
        db.semantics
          .filter((s) => s.companyId === companyId && s.channel === channel)
          .filter((s) => s.status === "ready" && s.vector !== null)
          // The JOIN — a semantics row whose post is gone contributes nothing.
          .filter((s) => db.posts.some((p) => p.id === s.postId))
          .sort((a, b) => b.postCreatedAt.getTime() - a.postCreatedAt.getTime())
          .slice(0, limit)
          .map((s) => ({
            postId: s.postId,
            coreMessage: db.posts.find((p) => p.id === s.postId)?.coreMessage ?? null,
            vector: s.vector as number[],
          }))
      );
    },
  };
}

/** An embedding provider that always returns the given vector. */
function providerReturning(vector: number[]): IEmbeddingProvider {
  return {
    provider: "fake",
    model: "fake-1024",
    dims: EMBEDDING_DIMENSIONS,
    async embed() {
      return {
        vectors: [vector],
        provider: "fake",
        model: "fake-1024",
        dims: EMBEDDING_DIMENSIONS,
      };
    },
  };
}

/** Mirrors generate-draft-post.service's recent-post window (Post rows, directly). */
function recentPostsOver(db: FakeDb) {
  return db.posts
    .filter((p) => p.companyId === COMPANY_ID && p.channel === CHANNEL)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map((p) => ({ id: p.id, text: p.content }));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("deleteDraft — the post and everything owned by it", () => {
  it("deletes the Post row", async () => {
    const db = makeDb();
    const result = await deletePostCore(SLUG, POST_ID, USER_ID, false, makeDeps(db));

    assert.equal(result.success, true);
    assert.equal(
      db.posts.find((p) => p.id === POST_ID),
      undefined
    );
    // …and leaves the company's other drafts alone.
    assert.ok(db.posts.some((p) => p.id === "post-keep"));
  });

  it("deletes the post's PostSemantics row", async () => {
    const db = makeDb();
    await deletePostCore(SLUG, POST_ID, USER_ID, false, makeDeps(db));

    assert.equal(
      db.semantics.find((s) => s.postId === POST_ID),
      undefined
    );
    assert.equal(db.semantics.length, 1);
  });

  it("deletes versions, metrics and metric snapshots belonging to the post", async () => {
    const db = makeDb();
    await deletePostCore(SLUG, POST_ID, USER_ID, false, makeDeps(db));

    assert.deepEqual(
      db.versions.map((v) => v.id),
      ["v3"] // the sibling post's version survives
    );
    assert.deepEqual(db.metrics, []);
    assert.deepEqual(db.snapshots, []);
  });

  it("records the deletion in the audit log", async () => {
    const db = makeDb();
    await deletePostCore(SLUG, POST_ID, USER_ID, false, makeDeps(db));

    assert.equal(db.auditLogs.length, 1);
    assert.equal(db.auditLogs[0].postId, POST_ID);
  });
});

describe("deleteDraft — duplicate detection must forget the post", () => {
  it("removes the draft from the semantic gate's neighbours", async () => {
    const db = makeDb();

    // Before: a candidate with the deleted draft's exact embedding is rejected.
    const gateBefore = createSemanticGate(COMPANY_ID, CHANNEL, {
      provider: providerReturning(vec(0)),
      store: semanticStoreOver(db),
    });
    const before = await gateBefore({ coreMessage: "The new roast is sweeter." });
    assert.equal(before.decision, "regenerate");
    assert.equal(before.matchedPostId, POST_ID);

    await deletePostCore(SLUG, POST_ID, USER_ID, false, makeDeps(db));

    // After: the same candidate finds only the surviving, unrelated post.
    const gateAfter = createSemanticGate(COMPANY_ID, CHANNEL, {
      provider: providerReturning(vec(0)),
      store: semanticStoreOver(db),
    });
    const after = await gateAfter({ coreMessage: "The new roast is sweeter." });
    assert.equal(after.decision, "accept");
    assert.notEqual(after.matchedPostId, POST_ID);
  });

  it("accepts with no history at all once the only embedded post is deleted", async () => {
    const db = makeDb({ semantics: [] });
    db.semantics = [
      {
        postId: POST_ID,
        companyId: COMPANY_ID,
        channel: CHANNEL,
        status: "ready",
        vector: vec(0),
        postCreatedAt: new Date("2026-08-10T09:00:00Z"),
      },
    ];

    await deletePostCore(SLUG, POST_ID, USER_ID, false, makeDeps(db));

    const gate = createSemanticGate(COMPANY_ID, CHANNEL, {
      provider: providerReturning(vec(0)),
      store: semanticStoreOver(db),
    });
    const result = await gate({ coreMessage: "The new roast is sweeter." });

    assert.equal(result.decision, "accept");
    assert.equal(result.topSimilarity, null);
    assert.equal(result.skipped, false);
  });

  it("removes the draft from the Jaccard/recent-post window", async () => {
    const db = makeDb();
    const candidate = "Our new roasting profile brings out the caramel notes in every cup.";

    const before = checkDuplicatePost({
      candidateText: candidate,
      recentPosts: recentPostsOver(db),
    });
    assert.equal(before.flagged, true);
    assert.equal(before.matchedPostId, POST_ID);

    await deletePostCore(SLUG, POST_ID, USER_ID, false, makeDeps(db));

    const after = checkDuplicatePost({
      candidateText: candidate,
      recentPosts: recentPostsOver(db),
    });
    assert.equal(after.flagged, false);
    assert.equal(after.matchedPostId, null);
  });

  it("leaves a stale semantics row unusable even if one somehow survived", async () => {
    // Defence in depth: the gate JOINs posts, so an orphaned embedding cannot be
    // matched against. Asserted so the join is never quietly dropped.
    const db = makeDb();
    const deps = makeDeps(db);
    const original = deps.deletePostAndOwnedRecords;
    deps.deletePostAndOwnedRecords = async (input) => {
      const keep = db.semantics.filter((s) => s.postId === input.postId);
      await original(input);
      db.semantics.push(...keep); // simulate a failed child cleanup
    };

    await deletePostCore(SLUG, POST_ID, USER_ID, false, deps);
    assert.ok(db.semantics.some((s) => s.postId === POST_ID));

    const gate = createSemanticGate(COMPANY_ID, CHANNEL, {
      provider: providerReturning(vec(0)),
      store: semanticStoreOver(db),
    });
    const result = await gate({ coreMessage: "The new roast is sweeter." });
    assert.notEqual(result.matchedPostId, POST_ID);
  });
});

describe("deleteDraft — media ownership", () => {
  it("classifies only AI images with no source url as post-exclusive", () => {
    assert.equal(isPostExclusiveAsset(AI_ASSET), true);
    assert.equal(isPostExclusiveAsset(ARTICLE_ASSET), false);
    assert.equal(isPostExclusiveAsset(UPLOAD_ASSET), false);
    // An AI generation later re-imported from an article is not exclusive either.
    assert.equal(
      isPostExclusiveAsset({ ...AI_ASSET, sourceUrl: "https://x.example/a.jpg" }),
      false
    );
  });

  it("deletes an AI image generated for this post alone, in DB and Cloudinary", async () => {
    const db = makeDb({ assets: [AI_ASSET] });
    db.posts[0].mediaAssetId = AI_ASSET.id;

    const result = await deletePostCore(SLUG, POST_ID, USER_ID, false, makeDeps(db));

    assert.equal(result.success, true);
    assert.deepEqual(result.success && result.data.deletedMediaAssetIds, [AI_ASSET.id]);
    assert.deepEqual(db.assets, []);
    assert.equal(db.cloudinary.has(AI_ASSET.cloudinaryId), false);
  });

  it("also cleans an exclusive image held in reserve after an image switch", async () => {
    const db = makeDb({ assets: [AI_ASSET, ARTICLE_ASSET] });
    db.posts[0].mediaAssetId = ARTICLE_ASSET.id;
    db.posts[0].previousMediaAssetId = AI_ASSET.id;

    const result = await deletePostCore(SLUG, POST_ID, USER_ID, false, makeDeps(db));

    assert.deepEqual(result.success && result.data.deletedMediaAssetIds, [AI_ASSET.id]);
    // The article image stays — it is the company's, and other posts reuse it.
    assert.deepEqual(
      db.assets.map((a) => a.id),
      [ARTICLE_ASSET.id]
    );
    assert.equal(db.cloudinary.has(ARTICLE_ASSET.cloudinaryId), true);
  });

  it("never deletes the source article's image", async () => {
    const db = makeDb({ assets: [ARTICLE_ASSET] });
    db.posts[0].mediaAssetId = ARTICLE_ASSET.id;

    const result = await deletePostCore(SLUG, POST_ID, USER_ID, false, makeDeps(db));

    assert.deepEqual(result.success && result.data.deletedMediaAssetIds, []);
    assert.deepEqual(
      db.assets.map((a) => a.id),
      [ARTICLE_ASSET.id]
    );
    assert.equal(db.cloudinary.has(ARTICLE_ASSET.cloudinaryId), true);
  });

  it("never deletes a company gallery upload", async () => {
    const db = makeDb({ assets: [UPLOAD_ASSET] });
    db.posts[0].mediaAssetId = UPLOAD_ASSET.id;

    await deletePostCore(SLUG, POST_ID, USER_ID, false, makeDeps(db));

    assert.deepEqual(
      db.assets.map((a) => a.id),
      [UPLOAD_ASSET.id]
    );
    assert.equal(db.cloudinary.has(UPLOAD_ASSET.cloudinaryId), true);
  });

  it("keeps an AI image that another post also uses", async () => {
    const db = makeDb({ assets: [AI_ASSET] });
    db.posts[0].mediaAssetId = AI_ASSET.id;
    db.posts[1].mediaAssetId = AI_ASSET.id;

    const result = await deletePostCore(SLUG, POST_ID, USER_ID, false, makeDeps(db));

    assert.deepEqual(result.success && result.data.deletedMediaAssetIds, []);
    assert.deepEqual(
      db.assets.map((a) => a.id),
      [AI_ASSET.id]
    );
    assert.equal(db.cloudinary.has(AI_ASSET.cloudinaryId), true);
  });

  it("keeps an AI image another post holds in reserve", async () => {
    // posts.previous_media_asset_id is ON DELETE RESTRICT, so missing this would
    // fail the whole transaction rather than merely lose an image.
    const db = makeDb({ assets: [AI_ASSET] });
    db.posts[0].mediaAssetId = AI_ASSET.id;
    db.posts[1].previousMediaAssetId = AI_ASSET.id;

    const result = await deletePostCore(SLUG, POST_ID, USER_ID, false, makeDeps(db));

    assert.deepEqual(result.success && result.data.deletedMediaAssetIds, []);
    assert.deepEqual(
      db.assets.map((a) => a.id),
      [AI_ASSET.id]
    );
  });

  it("counts an asset once when the post holds it in both slots", async () => {
    const db = makeDb({ assets: [AI_ASSET] });
    db.posts[0].mediaAssetId = AI_ASSET.id;
    db.posts[0].previousMediaAssetId = AI_ASSET.id;

    const result = await deletePostCore(SLUG, POST_ID, USER_ID, false, makeDeps(db));

    assert.deepEqual(result.success && result.data.deletedMediaAssetIds, [AI_ASSET.id]);
  });
});

describe("deleteDraft — Cloudinary failure is safe", () => {
  it("still deletes the post and reports the orphan when Cloudinary refuses", async () => {
    const db = makeDb({ assets: [AI_ASSET] });
    db.posts[0].mediaAssetId = AI_ASSET.id;

    const result = await deletePostCore(
      SLUG,
      POST_ID,
      USER_ID,
      false,
      makeDeps(db, { cloudinaryFails: true })
    );

    assert.equal(result.success, true);
    assert.deepEqual(result.success && result.data.orphanedCloudinaryIds, [AI_ASSET.cloudinaryId]);
    // The database is consistent: no post, no asset row, no dangling reference.
    assert.equal(
      db.posts.find((p) => p.id === POST_ID),
      undefined
    );
    assert.deepEqual(db.assets, []);
    // Only the remote file is left behind, and the audit log says so.
    assert.equal(db.cloudinary.has(AI_ASSET.cloudinaryId), true);
    assert.deepEqual(db.auditLogs[0].orphaned, [AI_ASSET.cloudinaryId]);
  });

  it("leaves everything intact and touches no remote file when the transaction fails", async () => {
    const db = makeDb({ assets: [AI_ASSET] });
    db.posts[0].mediaAssetId = AI_ASSET.id;

    await assert.rejects(() =>
      deletePostCore(SLUG, POST_ID, USER_ID, false, makeDeps(db, { transactionFails: true }))
    );

    assert.ok(db.posts.some((p) => p.id === POST_ID));
    assert.ok(db.semantics.some((s) => s.postId === POST_ID));
    assert.deepEqual(
      db.assets.map((a) => a.id),
      [AI_ASSET.id]
    );
    assert.equal(db.cloudinary.has(AI_ASSET.cloudinaryId), true);
    assert.deepEqual(db.auditLogs, []);
  });
});

describe("deleteDraft — status guard", () => {
  for (const status of [
    "pending_approval",
    "approved",
    "rejected",
    "sent_to_buffer",
    "published",
  ]) {
    it(`refuses to delete a ${status} post`, async () => {
      const db = makeDb();
      db.posts[0].status = status;

      const result = await deletePostCore(SLUG, POST_ID, USER_ID, false, makeDeps(db));

      assert.equal(result.success, false);
      assert.equal(result.success === false && result.code, "INVALID_STATUS");
      assert.match(String(result.success === false && result.message), /draft/i);
      // Nothing was touched.
      assert.ok(db.posts.some((p) => p.id === POST_ID));
      assert.ok(db.semantics.some((s) => s.postId === POST_ID));
    });
  }

  it("refuses a non-draft even for a global admin", async () => {
    const db = makeDb();
    db.posts[0].status = "published";

    const result = await deletePostCore(SLUG, POST_ID, USER_ID, true, makeDeps(db));
    assert.equal(result.success === false && result.code, "INVALID_STATUS");
  });
});

describe("deleteDraft — authorization", () => {
  it("hides the company from a non-member behind NOT_FOUND", async () => {
    const db = makeDb();
    const result = await deletePostCore(
      SLUG,
      POST_ID,
      USER_ID,
      false,
      makeDeps(db, { role: null })
    );

    assert.equal(result.success === false && result.code, "NOT_FOUND");
    assert.ok(db.posts.some((p) => p.id === POST_ID));
  });

  it("refuses an editor — deleting drafts is an owner action", async () => {
    const db = makeDb();
    const result = await deletePostCore(
      SLUG,
      POST_ID,
      USER_ID,
      false,
      makeDeps(db, { role: "editor" })
    );

    assert.equal(result.success === false && result.code, "FORBIDDEN");
    assert.ok(db.posts.some((p) => p.id === POST_ID));
  });

  it("cannot delete a draft belonging to another company", async () => {
    // The user owns OTHER_COMPANY_ID; the post lives in COMPANY_ID. The post
    // lookup is company-scoped, so it reads as NOT_FOUND rather than confirming
    // that the id exists somewhere.
    const db = makeDb();
    const result = await deletePostCore(
      SLUG,
      POST_ID,
      USER_ID,
      false,
      makeDeps(db, { memberOf: OTHER_COMPANY_ID })
    );

    assert.equal(result.success === false && result.code, "NOT_FOUND");
    assert.ok(db.posts.some((p) => p.id === POST_ID));
    assert.ok(db.semantics.some((s) => s.postId === POST_ID));
  });

  it("lets a global admin delete without a membership", async () => {
    const db = makeDb();
    const result = await deletePostCore(SLUG, POST_ID, USER_ID, true, makeDeps(db, { role: null }));

    assert.equal(result.success, true);
    assert.equal(
      db.posts.find((p) => p.id === POST_ID),
      undefined
    );
  });

  it("returns NOT_FOUND for a post id that does not exist", async () => {
    const db = makeDb();
    const result = await deletePostCore(SLUG, "nope", USER_ID, false, makeDeps(db));
    assert.equal(result.success === false && result.code, "NOT_FOUND");
  });
});
