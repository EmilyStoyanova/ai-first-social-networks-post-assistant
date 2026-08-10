import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  autoApplySourceImage,
  type AutoApplySourceImageDb,
} from "./auto-apply-source-image.service";
import type { ApplySourceImageResult } from "@/lib/services/posts/apply-source-image.service";

const AI_ASSET = "asset-ai";
const ARTICLE_ASSET = "asset-article";

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
}

function makeApply(result: ApplySourceImageResult | (() => never)) {
  const calls: Call[] = [];
  const applyImage = async (postId: string, userId: string) => {
    calls.push({ postId, userId });
    if (typeof result === "function") return result();
    return result;
  };
  return { applyImage, calls };
}

describe("autoApplySourceImage — the article's image leads", () => {
  it("applies the article image and reports what it displaced", async () => {
    const { applyImage } = makeApply(IMPORTED);

    const outcome = await autoApplySourceImage(
      { postId: "post-1", companyId: "co-1", generatedById: "user-1" },
      { db: db(), applyImage }
    );

    assert.deepEqual(outcome, {
      status: "applied",
      media: IMPORTED.media,
      // The AI asset the import pushed aside — still linked to the post.
      previousMediaId: AI_ASSET,
    });
  });

  it("attributes the import to the acting user when there is one", async () => {
    const { applyImage, calls } = makeApply(IMPORTED);

    await autoApplySourceImage(
      { postId: "post-1", companyId: "co-1", generatedById: "user-1" },
      { db: db("owner-1"), applyImage }
    );

    assert.deepEqual(calls, [{ postId: "post-1", userId: "user-1" }]);
  });

  it("falls back to the company creator for a cron post with no user", async () => {
    const { applyImage, calls } = makeApply(IMPORTED);

    await autoApplySourceImage(
      { postId: "post-1", companyId: "co-1" },
      { db: db("owner-1"), applyImage }
    );

    assert.equal(calls[0]?.userId, "owner-1");
  });

  it("reports a failure when there is nobody to attribute the asset to", async () => {
    const { applyImage, calls } = makeApply(IMPORTED);

    const outcome = await autoApplySourceImage(
      { postId: "post-1", companyId: "gone" },
      { db: db(null), applyImage }
    );

    assert.deepEqual(outcome, { status: "failed", code: "NO_ATTRIBUTABLE_USER" });
    assert.deepEqual(calls, [], "never reaches the import");
  });
});

describe("autoApplySourceImage — leaves other posts alone", () => {
  it("skips a post with no article image instead of calling it a failure", async () => {
    // What a brand-setup, prompt or calendar post reports — and an RSS article
    // that simply has no usable image.
    const { applyImage } = makeApply({ success: false, code: "NO_SOURCE_IMAGE" });

    const outcome = await autoApplySourceImage(
      { postId: "post-1", companyId: "co-1", generatedById: "user-1" },
      { db: db(), applyImage }
    );

    assert.deepEqual(outcome, { status: "skipped", reason: "no_source_image" });
  });

  it("skips when the article image is already the post's image", async () => {
    const { applyImage } = makeApply({
      success: true,
      media: IMPORTED.media,
      previousMediaId: null,
      unchanged: true,
    });

    const outcome = await autoApplySourceImage(
      { postId: "post-1", companyId: "co-1", generatedById: "user-1" },
      { db: db(), applyImage }
    );

    assert.deepEqual(outcome, { status: "skipped", reason: "already_current" });
  });
});

describe("autoApplySourceImage — never takes the post down", () => {
  it("reports a failed download without throwing", async () => {
    const { applyImage } = makeApply({
      success: false,
      code: "FETCH_FAILED",
      message: "404",
    });

    const outcome = await autoApplySourceImage(
      { postId: "post-1", companyId: "co-1", generatedById: "user-1" },
      { db: db(), applyImage }
    );

    assert.deepEqual(outcome, { status: "failed", code: "FETCH_FAILED", message: "404" });
  });

  it("swallows an unexpected throw from the import pipeline", async () => {
    const { applyImage } = makeApply(() => {
      throw new Error("cloudinary exploded");
    });

    const outcome = await autoApplySourceImage(
      { postId: "post-1", companyId: "co-1", generatedById: "user-1" },
      { db: db(), applyImage }
    );

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.status === "failed" ? outcome.code : "", "UNEXPECTED_ERROR");
    assert.match(outcome.status === "failed" ? (outcome.message ?? "") : "", /cloudinary exploded/);
  });
});
