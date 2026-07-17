import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { autoGeneratePostImage } from "./auto-generate-post-image.service";
import type {
  AutoGenerateImageDb,
  AutoGenerateImageDeps,
} from "./auto-generate-post-image.service";
import type { GeneratePostImageResult, ImageGenerationActor } from "./generate-post-image.service";

interface FakeOptions {
  mediaAssetId?: string | null;
  imagePrompt?: string | null;
  createdBy?: string;
  postExists?: boolean;
  result?: GeneratePostImageResult;
  throws?: Error;
}

interface Harness {
  deps: AutoGenerateImageDeps;
  calls: () => Array<{ postId: string; actor: ImageGenerationActor }>;
}

function makeDeps(options: FakeOptions = {}): Harness {
  const {
    mediaAssetId = null,
    imagePrompt = "A coffee cup",
    createdBy = "creator-1",
    postExists = true,
    result = {
      success: true,
      media: { id: "asset-1", url: "https://cdn.example/x.png", width: 1080, height: 1080 },
    },
    throws,
  } = options;

  const calls: Array<{ postId: string; actor: ImageGenerationActor }> = [];

  const db: AutoGenerateImageDb = {
    post: {
      findUnique: async () => (postExists ? { mediaAssetId, imagePrompt } : null),
    },
    company: {
      findUnique: async () => ({ createdBy }),
    },
  };

  return {
    deps: {
      db,
      generateImage: async (postId, actor) => {
        calls.push({ postId, actor });
        if (throws) throw throws;
        return result;
      },
    },
    calls: () => calls,
  };
}

const INPUT = { postId: "post-1", companyId: "co-1", generatedById: "u-1" };

describe("autoGeneratePostImage — setting disabled", () => {
  it("skips without touching the image pipeline", async () => {
    const { deps, calls } = makeDeps();
    const outcome = await autoGeneratePostImage({ ...INPUT, enabled: false }, deps);

    assert.deepEqual(outcome, { status: "skipped", reason: "disabled" });
    assert.equal(calls().length, 0);
  });
});

describe("autoGeneratePostImage — setting enabled", () => {
  it("generates and reports the attached media id", async () => {
    const { deps, calls } = makeDeps();
    const outcome = await autoGeneratePostImage({ ...INPUT, enabled: true }, deps);

    assert.deepEqual(outcome, { status: "generated", mediaId: "asset-1" });
    assert.equal(calls().length, 1);
    assert.equal(calls()[0].postId, "post-1");
  });

  it("attributes a user-initiated generation to the acting user", async () => {
    const { deps, calls } = makeDeps();
    await autoGeneratePostImage({ ...INPUT, enabled: true }, deps);

    assert.deepEqual(calls()[0].actor, { kind: "system", attributeToUserId: "u-1" });
  });

  it("falls back to the company creator for cron runs with no acting user", async () => {
    const { deps, calls } = makeDeps({ createdBy: "creator-9" });
    const outcome = await autoGeneratePostImage(
      { postId: "post-1", companyId: "co-1", enabled: true },
      deps
    );

    assert.equal(outcome.status, "generated");
    assert.deepEqual(calls()[0].actor, { kind: "system", attributeToUserId: "creator-9" });
  });
});

describe("autoGeneratePostImage — duplicate guard", () => {
  it("skips when the post already has media", async () => {
    const { deps, calls } = makeDeps({ mediaAssetId: "existing-asset" });
    const outcome = await autoGeneratePostImage({ ...INPUT, enabled: true }, deps);

    assert.deepEqual(outcome, { status: "skipped", reason: "already_has_media" });
    assert.equal(calls().length, 0);
  });

  it("skips a text-only post that has no image prompt", async () => {
    const { deps, calls } = makeDeps({ imagePrompt: null });
    const outcome = await autoGeneratePostImage({ ...INPUT, enabled: true }, deps);

    assert.deepEqual(outcome, { status: "skipped", reason: "no_image_prompt" });
    assert.equal(calls().length, 0);
  });
});

describe("autoGeneratePostImage — failure never breaks the post", () => {
  it("reports a provider failure without throwing", async () => {
    const { deps } = makeDeps({
      result: { success: false, code: "IMAGE_PROVIDER_ERROR", message: "provider down" },
    });
    const outcome = await autoGeneratePostImage({ ...INPUT, enabled: true }, deps);

    assert.deepEqual(outcome, {
      status: "failed",
      code: "IMAGE_PROVIDER_ERROR",
      message: "provider down",
    });
  });

  it("swallows an unexpected throw from the pipeline", async () => {
    const { deps } = makeDeps({ throws: new Error("socket hang up") });
    const outcome = await autoGeneratePostImage({ ...INPUT, enabled: true }, deps);

    assert.deepEqual(outcome, {
      status: "failed",
      code: "UNEXPECTED_ERROR",
      message: "socket hang up",
    });
  });

  it("reports a missing post rather than pretending it was skipped", async () => {
    const { deps, calls } = makeDeps({ postExists: false });
    const outcome = await autoGeneratePostImage({ ...INPUT, enabled: true }, deps);

    assert.deepEqual(outcome, { status: "failed", code: "NOT_FOUND" });
    assert.equal(calls().length, 0);
  });
});
