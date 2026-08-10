import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  listPostMediaCore,
  type ListPostMediaDeps,
  type PostMediaContext,
  type PostMediaRow,
} from "./list-post-media.service";

const CREATED = new Date("2026-08-01T10:00:00.000Z");

function row(overrides: Partial<PostMediaRow> = {}): PostMediaRow {
  return {
    id: "asset-ai",
    url: "https://cdn.example.com/ai.jpg",
    width: 1200,
    height: 630,
    createdAt: CREATED,
    cloudinaryId: "cld-1",
    generatedBy: "ai",
    sourceUrl: null,
    ...overrides,
  };
}

const ARTICLE_ROW = row({
  id: "asset-article",
  url: "https://cdn.example.com/article.jpg",
  cloudinaryId: "cld-2",
  generatedBy: "user_upload",
  sourceUrl: "https://news.example.com/photo.jpg",
});

function makeDeps(
  context: PostMediaContext | null,
  role: string | null = "editor"
): ListPostMediaDeps {
  return {
    loadContext: async () => context,
    loadRole: async () => role,
  };
}

function context(overrides: Partial<PostMediaContext> = {}): PostMediaContext {
  return { companyId: "co-1", current: null, previous: null, ...overrides };
}

describe("listPostMediaCore — what the post is holding", () => {
  it("returns the current image first, then the displaced one", async () => {
    const deps = makeDeps(context({ current: ARTICLE_ROW, previous: row() }));

    const result = await listPostMediaCore("post-1", "user-1", false, deps);

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.deepEqual(
      result.media.map((m) => [m.id, m.isCurrent, m.isPrevious]),
      [
        ["asset-article", true, false],
        ["asset-ai", false, true],
      ]
    );
  });

  it("keeps the AI image visible after the article image took the lead", async () => {
    // The whole point: generation attaches the article image and pushes the AI
    // asset to `previous`, where the picker must still find it.
    const deps = makeDeps(context({ current: ARTICLE_ROW, previous: row() }));

    const result = await listPostMediaCore("post-1", "user-1", false, deps);

    assert.equal(result.success, true);
    if (!result.success) return;
    const ai = result.media.filter((m) => m.generatedBy === "ai");
    assert.equal(ai.length, 1);
    assert.equal(ai[0].id, "asset-ai");
  });

  it("marks an imported image with the article address it came from", async () => {
    const deps = makeDeps(context({ current: ARTICLE_ROW }));

    const result = await listPostMediaCore("post-1", "user-1", false, deps);

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.media[0].sourceUrl, "https://news.example.com/photo.jpg");
  });

  it("returns an empty list for a post with no image yet", async () => {
    const result = await listPostMediaCore("post-1", "user-1", false, makeDeps(context()));

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.deepEqual(result.media, []);
  });

  it("lists an image once even if both columns point at it", async () => {
    const shared = row();
    const deps = makeDeps(context({ current: shared, previous: shared }));

    const result = await listPostMediaCore("post-1", "user-1", false, deps);

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.media.length, 1);
    assert.equal(result.media[0].isCurrent, true);
  });
});

describe("listPostMediaCore — access", () => {
  it("hides the post from a non-member rather than admitting it exists", async () => {
    const deps = makeDeps(context({ current: row() }), null);

    const result = await listPostMediaCore("post-1", "stranger", false, deps);

    assert.deepEqual(result, { success: false, code: "NOT_FOUND" });
  });

  it("refuses a member whose role cannot touch posts", async () => {
    const deps = makeDeps(context({ current: row() }), "viewer");

    const result = await listPostMediaCore("post-1", "user-1", false, deps);

    assert.deepEqual(result, { success: false, code: "FORBIDDEN" });
  });

  it("lets a global admin through without a membership", async () => {
    const deps = makeDeps(context({ current: row() }), null);

    const result = await listPostMediaCore("post-1", "admin", true, deps);

    assert.equal(result.success, true);
  });

  it("reports a missing post as not found", async () => {
    const result = await listPostMediaCore("gone", "user-1", false, makeDeps(null));

    assert.deepEqual(result, { success: false, code: "NOT_FOUND" });
  });
});
