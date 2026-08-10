import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  refreshSourceImagesCore,
  type RefreshCandidate,
  type RefreshResult,
  type RefreshSourceImagesDeps,
} from "./refresh-source-images.service";
import type { ExtractedArticle } from "@/lib/integrations/rss/article-extractor";

const OLD_IMAGE = "https://cdn.example.com/site-banner.jpg";
const NEW_IMAGE = "https://cdn.example.com/media/8f3c2a91.jpg";

const EMPTY_ARTICLE: ExtractedArticle = { text: null, metaImageUrl: null, contentImageUrl: null };

function article(overrides: Partial<ExtractedArticle>): ExtractedArticle {
  return { ...EMPTY_ARTICLE, ...overrides };
}

function candidate(overrides: Partial<RefreshCandidate> = {}): RefreshCandidate {
  return {
    feedItemId: "item-1",
    url: "https://news.example.com/gpu-review",
    storedImageUrl: OLD_IMAGE,
    ...overrides,
  };
}

interface Recorder {
  fetched: string[];
  persisted: Array<{ feedItemId: string; sourceImageUrl: string }>;
}

function makeDeps(options: {
  candidates: RefreshCandidate[];
  articles?: Record<string, ExtractedArticle>;
  fetchThrows?: (url: string) => boolean;
  persistThrows?: boolean;
}): { deps: RefreshSourceImagesDeps; log: Recorder } {
  const log: Recorder = { fetched: [], persisted: [] };

  const deps: RefreshSourceImagesDeps = {
    findCandidates: async (limit) =>
      limit ? options.candidates.slice(0, limit) : options.candidates,

    fetchArticle: async (url) => {
      log.fetched.push(url);
      if (options.fetchThrows?.(url)) throw new Error("socket hang up");
      return options.articles?.[url] ?? EMPTY_ARTICLE;
    },

    persist: async (feedItemId, sourceImageUrl) => {
      if (options.persistThrows) throw new Error("db down");
      log.persisted.push({ feedItemId, sourceImageUrl });
    },
  };

  return { deps, log };
}

describe("refreshSourceImagesCore — recomputing the image", () => {
  it("overwrites a stored image the current extraction disagrees with", async () => {
    const c = candidate();
    const { deps, log } = makeDeps({
      candidates: [c],
      articles: { [c.url]: article({ metaImageUrl: NEW_IMAGE }) },
    });

    const summary = await refreshSourceImagesCore(deps);

    assert.deepEqual(summary, { scanned: 1, updated: 1, unchanged: 0, noImage: 0, failed: 0 });
    assert.deepEqual(log.persisted, [{ feedItemId: "item-1", sourceImageUrl: NEW_IMAGE }]);
  });

  it("does not trust the stored value — it refetches even when one is present", async () => {
    const c = candidate({ storedImageUrl: OLD_IMAGE });
    const { deps, log } = makeDeps({
      candidates: [c],
      articles: { [c.url]: article({ metaImageUrl: NEW_IMAGE }) },
    });

    await refreshSourceImagesCore(deps);

    assert.deepEqual(log.fetched, [c.url]);
  });

  it("writes nothing when the recomputed image matches what is stored", async () => {
    const c = candidate({ storedImageUrl: NEW_IMAGE });
    const { deps, log } = makeDeps({
      candidates: [c],
      articles: { [c.url]: article({ metaImageUrl: NEW_IMAGE }) },
    });

    const summary = await refreshSourceImagesCore(deps);

    assert.deepEqual(summary, { scanned: 1, updated: 0, unchanged: 1, noImage: 0, failed: 0 });
    assert.deepEqual(log.persisted, []);
  });

  it("fills in an item that never had an image", async () => {
    const c = candidate({ storedImageUrl: null });
    const { deps, log } = makeDeps({
      candidates: [c],
      articles: { [c.url]: article({ contentImageUrl: NEW_IMAGE }) },
    });

    const summary = await refreshSourceImagesCore(deps);

    assert.equal(summary.updated, 1);
    assert.deepEqual(log.persisted, [{ feedItemId: "item-1", sourceImageUrl: NEW_IMAGE }]);
  });

  it("uses the same priority order as ingestion (meta beats content)", async () => {
    const c = candidate({ storedImageUrl: null });
    const { deps, log } = makeDeps({
      candidates: [c],
      articles: {
        [c.url]: article({ metaImageUrl: NEW_IMAGE, contentImageUrl: OLD_IMAGE }),
      },
    });

    await refreshSourceImagesCore(deps);

    assert.equal(log.persisted[0]?.sourceImageUrl, NEW_IMAGE);
  });
});

describe("refreshSourceImagesCore — leaves things alone", () => {
  it("keeps the stored image when the article now yields nothing", async () => {
    // Offline, paywalled or image removed — indistinguishable from here, and the
    // stored value is the better guess in every one of those cases.
    const c = candidate({ storedImageUrl: OLD_IMAGE });
    const { deps, log } = makeDeps({ candidates: [c] });

    const summary = await refreshSourceImagesCore(deps);

    assert.deepEqual(summary, { scanned: 1, updated: 0, unchanged: 0, noImage: 1, failed: 0 });
    assert.deepEqual(log.persisted, []);
  });

  it("reports an item that had no image and still has none", async () => {
    const { deps } = makeDeps({ candidates: [candidate({ storedImageUrl: null })] });

    const summary = await refreshSourceImagesCore(deps);

    assert.equal(summary.noImage, 1);
    assert.equal(summary.failed, 0);
  });

  it("writes nothing at all in a dry run", async () => {
    const c = candidate();
    const { deps, log } = makeDeps({
      candidates: [c],
      articles: { [c.url]: article({ metaImageUrl: NEW_IMAGE }) },
    });

    const summary = await refreshSourceImagesCore(deps, { dryRun: true });

    assert.equal(summary.updated, 1, "still reports what it would change");
    assert.deepEqual(log.persisted, [], "but touches nothing");
  });
});

describe("refreshSourceImagesCore — one article never ends the run", () => {
  it("continues past an article that cannot be fetched", async () => {
    const broken = candidate({ feedItemId: "item-1", url: "https://news.example.com/gone" });
    const ok = candidate({ feedItemId: "item-2", url: "https://news.example.com/fine" });
    const { deps, log } = makeDeps({
      candidates: [broken, ok],
      articles: { [ok.url]: article({ metaImageUrl: NEW_IMAGE }) },
      fetchThrows: (url) => url === broken.url,
    });

    const summary = await refreshSourceImagesCore(deps);

    assert.deepEqual(summary, { scanned: 2, updated: 1, unchanged: 0, noImage: 0, failed: 1 });
    assert.deepEqual(log.persisted, [{ feedItemId: "item-2", sourceImageUrl: NEW_IMAGE }]);
  });

  it("counts a failed write as failed, not updated", async () => {
    const c = candidate();
    const { deps } = makeDeps({
      candidates: [c],
      articles: { [c.url]: article({ metaImageUrl: NEW_IMAGE }) },
      persistThrows: true,
    });

    const summary = await refreshSourceImagesCore(deps);

    assert.deepEqual(summary, { scanned: 1, updated: 0, unchanged: 0, noImage: 0, failed: 1 });
  });

  it("reports the failure reason per item", async () => {
    const c = candidate();
    const results: RefreshResult[] = [];
    const { deps } = makeDeps({ candidates: [c], fetchThrows: () => true });

    await refreshSourceImagesCore(deps, { onResult: (r) => results.push(r) });

    assert.equal(results.length, 1);
    assert.equal(results[0].outcome.kind, "failed");
    assert.match(
      results[0].outcome.kind === "failed" ? results[0].outcome.error : "",
      /socket hang up/
    );
  });
});

describe("refreshSourceImagesCore — batching", () => {
  it("fetches each article only once, however many times it is listed", async () => {
    const c = candidate();
    const { deps, log } = makeDeps({
      candidates: [c, { ...c }, { ...c, storedImageUrl: null }],
      articles: { [c.url]: article({ metaImageUrl: NEW_IMAGE }) },
    });

    const summary = await refreshSourceImagesCore(deps);

    assert.equal(summary.scanned, 1);
    assert.deepEqual(log.fetched, [c.url]);
    assert.equal(log.persisted.length, 1);
  });

  it("passes the limit down to the query rather than fetching and discarding", async () => {
    const candidates = [
      candidate({ feedItemId: "a", url: "https://news.example.com/a" }),
      candidate({ feedItemId: "b", url: "https://news.example.com/b" }),
      candidate({ feedItemId: "c", url: "https://news.example.com/c" }),
    ];
    const { deps, log } = makeDeps({ candidates });

    const summary = await refreshSourceImagesCore(deps, { limit: 2 });

    assert.equal(summary.scanned, 2);
    assert.deepEqual(log.fetched, ["https://news.example.com/a", "https://news.example.com/b"]);
  });

  it("reports every outcome kind in one summary", async () => {
    const updated = candidate({ feedItemId: "a", url: "https://news.example.com/a" });
    const same = candidate({
      feedItemId: "b",
      url: "https://news.example.com/b",
      storedImageUrl: NEW_IMAGE,
    });
    const none = candidate({ feedItemId: "c", url: "https://news.example.com/c" });
    const broken = candidate({ feedItemId: "d", url: "https://news.example.com/d" });

    const { deps } = makeDeps({
      candidates: [updated, same, none, broken],
      articles: {
        [updated.url]: article({ metaImageUrl: NEW_IMAGE }),
        [same.url]: article({ metaImageUrl: NEW_IMAGE }),
      },
      fetchThrows: (url) => url === broken.url,
    });

    const summary = await refreshSourceImagesCore(deps);

    assert.deepEqual(summary, { scanned: 4, updated: 1, unchanged: 1, noImage: 1, failed: 1 });
  });

  it("handles an empty candidate set", async () => {
    const { deps, log } = makeDeps({ candidates: [] });

    const summary = await refreshSourceImagesCore(deps);

    assert.deepEqual(summary, { scanned: 0, updated: 0, unchanged: 0, noImage: 0, failed: 0 });
    assert.deepEqual(log.fetched, []);
  });
});
