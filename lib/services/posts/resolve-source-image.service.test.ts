import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveSourceImageCore,
  type ArticleContext,
  type ResolveSourceImageDeps,
} from "./resolve-source-image.service";
import type { ExtractedArticle } from "@/lib/integrations/rss/article-extractor";

const POST_ID = "post-1";
const USER_ID = "user-1";
const COMPANY_ID = "company-1";
const FEED_ITEM_ID = "item-1";
const ARTICLE_URL = "https://news.example.com/gpu-review";
const OG_IMAGE = "https://cdn.example.com/lead.jpg";

const EMPTY_ARTICLE: ExtractedArticle = {
  text: null,
  method: null,
  error: "no_article_text",
  metaImageUrl: null,
  contentImageUrl: null,
};

interface Recorder {
  fetched: string[];
  persisted: Array<{ feedItemId: string; sourceImageUrl: string }>;
}

function makeDeps(
  overrides: {
    context?: Partial<ArticleContext> | null;
    role?: string | null;
    article?: ExtractedArticle;
    persistThrows?: boolean;
  } = {}
): { deps: ResolveSourceImageDeps; log: Recorder } {
  const log: Recorder = { fetched: [], persisted: [] };

  const context: ArticleContext | null =
    overrides.context === null
      ? null
      : {
          companyId: COMPANY_ID,
          feedItemId: FEED_ITEM_ID,
          articleUrl: ARTICLE_URL,
          isArticle: true,
          sourceImageUrl: null,
          ...overrides.context,
        };

  const deps: ResolveSourceImageDeps = {
    loadContext: async () => context,
    loadRole: async () => (overrides.role === undefined ? "editor" : overrides.role),
    fetchArticle: async (url) => {
      log.fetched.push(url);
      return overrides.article ?? EMPTY_ARTICLE;
    },
    persist: async (feedItemId, sourceImageUrl) => {
      if (overrides.persistThrows) throw new Error("db down");
      log.persisted.push({ feedItemId, sourceImageUrl });
    },
  };

  return { deps, log };
}

describe("resolveSourceImage — access control", () => {
  it("reports NOT_FOUND for a post that does not exist", async () => {
    const { deps } = makeDeps({ context: null });
    const result = await resolveSourceImageCore(POST_ID, USER_ID, false, deps);
    assert.deepEqual(result, { success: false, code: "NOT_FOUND" });
  });

  it("hides the post from a non-member behind NOT_FOUND", async () => {
    const { deps, log } = makeDeps({ role: null });
    const result = await resolveSourceImageCore(POST_ID, USER_ID, false, deps);
    assert.deepEqual(result, { success: false, code: "NOT_FOUND" });
    assert.equal(log.fetched.length, 0, "no article should be scraped for a stranger");
  });

  it("rejects a member whose role may not touch posts", async () => {
    const { deps } = makeDeps({ role: "viewer" });
    const result = await resolveSourceImageCore(POST_ID, USER_ID, false, deps);
    assert.deepEqual(result, { success: false, code: "FORBIDDEN" });
  });

  it("lets a global admin through without a membership", async () => {
    const { deps } = makeDeps({
      context: { sourceImageUrl: OG_IMAGE },
      role: null,
    });
    const result = await resolveSourceImageCore(POST_ID, USER_ID, true, deps);
    assert.deepEqual(result, { success: true, sourceImageUrl: OG_IMAGE });
  });
});

describe("resolveSourceImage — the stored value", () => {
  it("returns what ingestion already stored without touching the network", async () => {
    const { deps, log } = makeDeps({ context: { sourceImageUrl: OG_IMAGE } });
    const result = await resolveSourceImageCore(POST_ID, USER_ID, false, deps);

    assert.deepEqual(result, { success: true, sourceImageUrl: OG_IMAGE });
    assert.equal(log.fetched.length, 0);
    assert.equal(log.persisted.length, 0, "nothing to re-persist");
  });
});

describe("resolveSourceImage — posts with no article", () => {
  it("returns null for a brand-setup post, with no feed item at all", async () => {
    const { deps, log } = makeDeps({
      context: { feedItemId: null, articleUrl: null, isArticle: false },
    });
    const result = await resolveSourceImageCore(POST_ID, USER_ID, false, deps);

    assert.deepEqual(result, { success: true, sourceImageUrl: null });
    assert.equal(log.fetched.length, 0);
  });

  it("returns null for a prompt / calendar / product-page source", async () => {
    const { deps, log } = makeDeps({
      // The relation exists, but the source is not an external article.
      context: { isArticle: false, articleUrl: null },
      article: { ...EMPTY_ARTICLE, metaImageUrl: OG_IMAGE },
    });
    const result = await resolveSourceImageCore(POST_ID, USER_ID, false, deps);

    assert.deepEqual(result, { success: true, sourceImageUrl: null });
    assert.equal(log.fetched.length, 0, "a non-article source is never scraped");
  });
});

describe("resolveSourceImage — resolving an old feed item on demand", () => {
  it("scrapes the article and persists what it finds", async () => {
    const { deps, log } = makeDeps({
      article: { ...EMPTY_ARTICLE, metaImageUrl: OG_IMAGE },
    });
    const result = await resolveSourceImageCore(POST_ID, USER_ID, false, deps);

    assert.deepEqual(result, { success: true, sourceImageUrl: OG_IMAGE });
    assert.deepEqual(log.fetched, [ARTICLE_URL]);
    assert.deepEqual(log.persisted, [{ feedItemId: FEED_ITEM_ID, sourceImageUrl: OG_IMAGE }]);
  });

  it("falls back to an in-content image when the page declares none", async () => {
    const inContent = "https://cdn.example.com/body-shot.jpg";
    const { deps, log } = makeDeps({
      article: { ...EMPTY_ARTICLE, contentImageUrl: inContent },
    });
    const result = await resolveSourceImageCore(POST_ID, USER_ID, false, deps);

    assert.deepEqual(result, { success: true, sourceImageUrl: inContent });
    assert.deepEqual(log.persisted, [{ feedItemId: FEED_ITEM_ID, sourceImageUrl: inContent }]);
  });

  it("prefers the publisher's declared image over one found in the body", async () => {
    const { deps } = makeDeps({
      article: {
        ...EMPTY_ARTICLE,
        metaImageUrl: OG_IMAGE,
        contentImageUrl: "https://cdn.example.com/body-shot.jpg",
      },
    });
    const result = await resolveSourceImageCore(POST_ID, USER_ID, false, deps);
    assert.deepEqual(result, { success: true, sourceImageUrl: OG_IMAGE });
  });

  it("returns null and persists nothing when the article has no usable image", async () => {
    const { deps, log } = makeDeps();
    const result = await resolveSourceImageCore(POST_ID, USER_ID, false, deps);

    assert.deepEqual(result, { success: true, sourceImageUrl: null });
    assert.deepEqual(log.fetched, [ARTICLE_URL]);
    assert.equal(log.persisted.length, 0, "null must never be written over the column");
  });

  it("still answers when the write-back fails — the caching is best effort", async () => {
    const { deps } = makeDeps({
      article: { ...EMPTY_ARTICLE, metaImageUrl: OG_IMAGE },
      persistThrows: true,
    });
    const result = await resolveSourceImageCore(POST_ID, USER_ID, false, deps);
    assert.deepEqual(result, { success: true, sourceImageUrl: OG_IMAGE });
  });

  it("never fetches twice for the same answer — the second read hits the column", async () => {
    // Simulates the write-back having landed: the context now carries the value,
    // which is the whole point of persisting it.
    const { deps: first, log: firstLog } = makeDeps({
      article: { ...EMPTY_ARTICLE, metaImageUrl: OG_IMAGE },
    });
    await resolveSourceImageCore(POST_ID, USER_ID, false, first);
    assert.equal(firstLog.fetched.length, 1);

    const { deps: second, log: secondLog } = makeDeps({ context: { sourceImageUrl: OG_IMAGE } });
    await resolveSourceImageCore(POST_ID, USER_ID, false, second);
    assert.equal(secondLog.fetched.length, 0);
  });
});
