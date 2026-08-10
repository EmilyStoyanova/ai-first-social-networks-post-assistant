import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  autoApplySourceImage,
  type AutoApplySourceImageDb,
} from "./auto-apply-source-image.service";
import type { ApplySourceImageResult } from "@/lib/services/posts/apply-source-image.service";
import type { ResolveSourceImageResult } from "@/lib/services/posts/resolve-source-image.service";

const AI_ASSET = "asset-ai";
const ARTICLE_ASSET = "asset-article";
const ARTICLE_IMAGE = "https://news.example.com/story-lead.jpg";

const IMPORTED: ApplySourceImageResult = {
  success: true,
  media: {
    id: ARTICLE_ASSET,
    url: "https://cdn.example.com/article.jpg",
    width: 1200,
    height: 630,
  },
  previousMediaId: AI_ASSET,
  unchanged: false,
};

function db(createdBy: string | null = "owner-1"): AutoApplySourceImageDb {
  return {
    company: {
      findUnique: async () => (createdBy === null ? null : { createdBy }),
    },
  };
}

interface Call {
  postId: string;
  userId: string;
  sourceImageUrl?: string;
}

function makeApply(result: ApplySourceImageResult | (() => never)) {
  const calls: Call[] = [];
  const applyImage = async (postId: string, userId: string, sourceImageUrl: string) => {
    calls.push({ postId, userId, sourceImageUrl });
    if (typeof result === "function") return result();
    return result;
  };
  return { applyImage, calls };
}

/**
 * The article-image lookup. `found` is what the real resolver returns after
 * reading the stored value OR scraping the article — this service cannot tell
 * the two apart, and deliberately so.
 */
function makeResolve(
  result: ResolveSourceImageResult | (() => never) = {
    success: true,
    sourceImageUrl: ARTICLE_IMAGE,
  }
) {
  const calls: Call[] = [];
  const resolveImage = async (postId: string, userId: string) => {
    calls.push({ postId, userId });
    if (typeof result === "function") return result();
    return result;
  };
  return { resolveImage, calls };
}

describe("autoApplySourceImage — the article's image leads", () => {
  it("applies the article image and reports what it displaced", async () => {
    const { applyImage } = makeApply(IMPORTED);
    const { resolveImage } = makeResolve();

    const outcome = await autoApplySourceImage(
      { postId: "post-1", companyId: "co-1", generatedById: "user-1" },
      { db: db(), resolveImage, applyImage }
    );

    assert.deepEqual(outcome, {
      status: "applied",
      media: IMPORTED.media,
      // The AI asset the import pushed aside — still linked to the post.
      previousMediaId: AI_ASSET,
    });
  });

  it("imports the image the resolver found, whether stored or scraped", async () => {
    // The regression this whole service exists for: an item ingested before
    // images were resolved has `sourceImageUrl` null, the resolver scrapes the
    // article, and the import must run on THAT answer rather than on the empty
    // column. From here the two cases are indistinguishable — which is the point.
    const { applyImage, calls } = makeApply(IMPORTED);
    const scraped = "https://news.example.com/scraped-lead.jpg";
    const { resolveImage } = makeResolve({ success: true, sourceImageUrl: scraped });

    const outcome = await autoApplySourceImage(
      { postId: "post-1", companyId: "co-1", generatedById: "user-1" },
      { db: db(), resolveImage, applyImage }
    );

    assert.equal(outcome.status, "applied");
    assert.equal(calls[0]?.sourceImageUrl, scraped);
  });

  it("attributes both steps to the acting user when there is one", async () => {
    const { applyImage, calls } = makeApply(IMPORTED);
    const { resolveImage, calls: resolveCalls } = makeResolve();

    await autoApplySourceImage(
      { postId: "post-1", companyId: "co-1", generatedById: "user-1" },
      { db: db("owner-1"), resolveImage, applyImage }
    );

    assert.deepEqual(resolveCalls, [{ postId: "post-1", userId: "user-1" }]);
    assert.deepEqual(calls, [
      { postId: "post-1", userId: "user-1", sourceImageUrl: ARTICLE_IMAGE },
    ]);
  });

  it("falls back to the company creator for a cron post with no user", async () => {
    const { applyImage, calls } = makeApply(IMPORTED);
    const { resolveImage } = makeResolve();

    await autoApplySourceImage(
      { postId: "post-1", companyId: "co-1" },
      { db: db("owner-1"), resolveImage, applyImage }
    );

    assert.equal(calls[0]?.userId, "owner-1");
  });

  it("reports a failure when there is nobody to attribute the asset to", async () => {
    const { applyImage, calls } = makeApply(IMPORTED);
    const { resolveImage, calls: resolveCalls } = makeResolve();

    const outcome = await autoApplySourceImage(
      { postId: "post-1", companyId: "gone" },
      { db: db(null), resolveImage, applyImage }
    );

    assert.deepEqual(outcome, { status: "failed", code: "NO_ATTRIBUTABLE_USER" });
    assert.deepEqual(resolveCalls, [], "never even looks the image up");
    assert.deepEqual(calls, [], "never reaches the import");
  });
});

describe("autoApplySourceImage — leaves other posts alone", () => {
  it("skips without importing when no article image can be found", async () => {
    // What a brand-setup, prompt or calendar post reports — and an RSS article
    // that genuinely has no usable image, whether stored or scraped.
    const { applyImage, calls } = makeApply(IMPORTED);
    const { resolveImage } = makeResolve({ success: true, sourceImageUrl: null });

    const outcome = await autoApplySourceImage(
      { postId: "post-1", companyId: "co-1", generatedById: "user-1" },
      { db: db(), resolveImage, applyImage }
    );

    assert.deepEqual(outcome, { status: "skipped", reason: "no_source_image" });
    assert.deepEqual(calls, [], "nothing to download, so nothing is attempted");
  });

  it("skips when the article image is already the post's image", async () => {
    const { applyImage } = makeApply({
      success: true,
      media: IMPORTED.media,
      previousMediaId: null,
      unchanged: true,
    });
    const { resolveImage } = makeResolve();

    const outcome = await autoApplySourceImage(
      { postId: "post-1", companyId: "co-1", generatedById: "user-1" },
      { db: db(), resolveImage, applyImage }
    );

    assert.deepEqual(outcome, { status: "skipped", reason: "already_current" });
  });

  it("skips when the FeedItem loses its image between the two steps", async () => {
    // A race, not a state the resolver can report: it said yes, the import found
    // nothing. Still the AI image's win, and still not worth calling a failure.
    const { applyImage } = makeApply({ success: false, code: "NO_SOURCE_IMAGE" });
    const { resolveImage } = makeResolve();

    const outcome = await autoApplySourceImage(
      { postId: "post-1", companyId: "co-1", generatedById: "user-1" },
      { db: db(), resolveImage, applyImage }
    );

    assert.deepEqual(outcome, { status: "skipped", reason: "no_source_image" });
  });
});

describe("autoApplySourceImage — never takes the post down", () => {
  it("reports a failed download without throwing", async () => {
    const { applyImage } = makeApply({
      success: false,
      code: "FETCH_FAILED",
      message: "404",
    });
    const { resolveImage } = makeResolve();

    const outcome = await autoApplySourceImage(
      { postId: "post-1", companyId: "co-1", generatedById: "user-1" },
      { db: db(), resolveImage, applyImage }
    );

    assert.deepEqual(outcome, { status: "failed", code: "FETCH_FAILED", message: "404" });
  });

  it("swallows an unexpected throw from the import pipeline", async () => {
    const { applyImage } = makeApply(() => {
      throw new Error("cloudinary exploded");
    });
    const { resolveImage } = makeResolve();

    const outcome = await autoApplySourceImage(
      { postId: "post-1", companyId: "co-1", generatedById: "user-1" },
      { db: db(), resolveImage, applyImage }
    );

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.status === "failed" ? outcome.code : "", "UNEXPECTED_ERROR");
    assert.match(outcome.status === "failed" ? (outcome.message ?? "") : "", /cloudinary exploded/);
  });

  it("reports a lookup that could not read the post", async () => {
    const { applyImage, calls } = makeApply(IMPORTED);
    const { resolveImage } = makeResolve({ success: false, code: "NOT_FOUND" });

    const outcome = await autoApplySourceImage(
      { postId: "gone", companyId: "co-1", generatedById: "user-1" },
      { db: db(), resolveImage, applyImage }
    );

    assert.deepEqual(outcome, { status: "failed", code: "NOT_FOUND" });
    assert.deepEqual(calls, []);
  });

  it("swallows an unexpected throw from the article scrape", async () => {
    // `extractArticle` is documented not to throw, so this proves generation
    // survives even if that contract is ever broken by a network layer below it.
    const { applyImage } = makeApply(IMPORTED);
    const { resolveImage } = makeResolve(() => {
      throw new Error("dns exploded");
    });

    const outcome = await autoApplySourceImage(
      { postId: "post-1", companyId: "co-1", generatedById: "user-1" },
      { db: db(), resolveImage, applyImage }
    );

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.status === "failed" ? outcome.code : "", "UNEXPECTED_ERROR");
    assert.match(outcome.status === "failed" ? (outcome.message ?? "") : "", /dns exploded/);
  });
});
