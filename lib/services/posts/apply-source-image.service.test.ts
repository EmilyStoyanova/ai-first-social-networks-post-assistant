import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applySourceImageCore,
  type CreateImportedAssetInput,
  type PostImageDTO,
  type SourceImageContext,
  type ApplySourceImageDeps,
} from "./apply-source-image.service";

const POST_ID = "post-1";
const USER_ID = "user-1";
const COMPANY_ID = "company-1";
const SOURCE_IMAGE = "https://publisher.example/img/lead.jpg";

const AI_ASSET: PostImageDTO = {
  id: "asset-ai",
  url: "https://res.cloudinary.com/x/ai.png",
  width: 1200,
  height: 632,
};

/** Records every write so a test can assert what did — and did not — happen. */
interface Recorder {
  created: CreateImportedAssetInput[];
  postWrites: Array<{ mediaAssetId: string; previousMediaAssetId: string | null }>;
  audits: number;
  fetched: string[];
  uploads: number;
}

function makeDeps(
  overrides: {
    context?: Partial<SourceImageContext> | null;
    role?: string | null;
    existing?: PostImageDTO | null;
    fetchResult?: Awaited<ReturnType<ApplySourceImageDeps["fetchImage"]>>;
    uploadResult?: Awaited<ReturnType<ApplySourceImageDeps["upload"]>>;
  } = {}
): { deps: ApplySourceImageDeps; log: Recorder } {
  const log: Recorder = { created: [], postWrites: [], audits: 0, fetched: [], uploads: 0 };

  const context: SourceImageContext | null =
    overrides.context === null
      ? null
      : {
          companyId: COMPANY_ID,
          companySlug: "acme",
          mediaAssetId: AI_ASSET.id,
          sourceImageUrl: SOURCE_IMAGE,
          ...overrides.context,
        };

  const deps: ApplySourceImageDeps = {
    loadContext: async () => context,
    loadRole: async () => (overrides.role === undefined ? "editor" : overrides.role),
    findImported: async () => overrides.existing ?? null,
    createImported: async (input) => {
      log.created.push(input);
      return {
        id: "asset-source",
        url: "https://res.cloudinary.com/x/source.jpg",
        width: 800,
        height: 600,
      };
    },
    setPostImage: async (_postId, mediaAssetId, previousMediaAssetId) => {
      log.postWrites.push({ mediaAssetId, previousMediaAssetId });
    },
    fetchImage: async (url) => {
      log.fetched.push(url);
      return (
        overrides.fetchResult ?? {
          success: true,
          blob: new Blob([new Uint8Array(64)], { type: "image/jpeg" }),
          contentType: "image/jpeg",
        }
      );
    },
    upload: async () => {
      log.uploads++;
      return (
        overrides.uploadResult ?? {
          success: true,
          asset: {
            publicId: "companies/acme/source",
            url: "https://res.cloudinary.com/x/source.jpg",
            width: 800,
            height: 600,
          },
        }
      );
    },
    audit: async () => {
      log.audits++;
    },
  };

  return { deps, log };
}

// ─── The happy path ───────────────────────────────────────────────────────────

describe("useSourceImage — importing the article image", () => {
  it("downloads, uploads, creates a MediaAsset and attaches it", async () => {
    const { deps, log } = makeDeps();
    const result = await applySourceImageCore(POST_ID, USER_ID, false, deps);

    assert.equal(result.success, true);
    assert.deepEqual(log.fetched, [SOURCE_IMAGE], "the article's image is what gets downloaded");
    assert.equal(log.uploads, 1, "it goes through our own Cloudinary pipeline, never hotlinked");
    assert.equal(log.created.length, 1);
    assert.equal(log.created[0].sourceUrl, SOURCE_IMAGE, "provenance is recorded on the asset");
    assert.equal(log.created[0].companyId, COMPANY_ID);
    assert.equal(log.postWrites.length, 1);
    assert.equal(log.postWrites[0].mediaAssetId, "asset-source");
    assert.equal(log.audits, 1);
  });

  it("keeps the AI image as the post's previous image rather than deleting it", async () => {
    // The whole point of the feature: an already-paid-for generation survives.
    const { deps, log } = makeDeps();
    const result = await applySourceImageCore(POST_ID, USER_ID, false, deps);

    assert.equal(log.postWrites[0].previousMediaAssetId, AI_ASSET.id);
    assert.equal(result.success && result.previousMediaId, AI_ASSET.id);
  });

  it("orders the work so nothing is written before the image is in hand", async () => {
    const { deps, log } = makeDeps();
    await applySourceImageCore(POST_ID, USER_ID, false, deps);
    assert.ok(
      log.fetched.length === 1 && log.uploads === 1 && log.postWrites.length === 1,
      "download → upload → repoint, exactly once each"
    );
  });

  it("records a null previous image when the post had none", async () => {
    const { deps, log } = makeDeps({ context: { mediaAssetId: null } });
    const result = await applySourceImageCore(POST_ID, USER_ID, false, deps);
    assert.equal(log.postWrites[0].previousMediaAssetId, null);
    assert.equal(result.success && result.previousMediaId, null);
  });
});

// ─── Reuse ────────────────────────────────────────────────────────────────────

describe("useSourceImage — reusing an already-imported asset", () => {
  const IMPORTED: PostImageDTO = {
    id: "asset-source",
    url: "https://res.cloudinary.com/x/source.jpg",
    width: 800,
    height: 600,
  };

  it("attaches the existing asset without downloading or uploading again", async () => {
    const { deps, log } = makeDeps({ existing: IMPORTED });
    const result = await applySourceImageCore(POST_ID, USER_ID, false, deps);

    assert.equal(result.success, true);
    assert.deepEqual(log.fetched, [], "no second download");
    assert.equal(log.uploads, 0, "no second Cloudinary upload");
    assert.equal(log.created.length, 0, "no duplicate MediaAsset row");
    assert.equal(log.postWrites[0].mediaAssetId, IMPORTED.id);
    assert.equal(log.postWrites[0].previousMediaAssetId, AI_ASSET.id);
  });

  it("does nothing when the article image is already the attached one", async () => {
    // Writing here would set previousMediaAssetId to the source image itself and
    // strand the AI image the user still wants to get back to.
    const { deps, log } = makeDeps({
      existing: IMPORTED,
      context: { mediaAssetId: IMPORTED.id },
    });
    const result = await applySourceImageCore(POST_ID, USER_ID, false, deps);

    assert.equal(result.success, true);
    assert.equal(result.success && result.unchanged, true);
    assert.deepEqual(log.postWrites, [], "the post row is left completely alone");
    assert.equal(log.audits, 0);
  });
});

// ─── Posts that must not offer this ───────────────────────────────────────────

describe("useSourceImage — posts with no source image", () => {
  it("refuses a post whose article has no image", async () => {
    const { deps, log } = makeDeps({ context: { sourceImageUrl: null } });
    const result = await applySourceImageCore(POST_ID, USER_ID, false, deps);

    assert.equal(result.success === false && result.code, "NO_SOURCE_IMAGE");
    assert.deepEqual(log.postWrites, [], "the post keeps the image it had");
    assert.deepEqual(log.fetched, []);
  });

  it("refuses a brand-setup post — no article behind it at all", async () => {
    // A post with no feed item reaches the service with a null source image, so
    // it takes the same path as an article without one.
    const { deps } = makeDeps({ context: { sourceImageUrl: null, mediaAssetId: AI_ASSET.id } });
    const result = await applySourceImageCore(POST_ID, USER_ID, false, deps);
    assert.equal(result.success === false && result.code, "NO_SOURCE_IMAGE");
  });

  it("returns NOT_FOUND for a post that does not exist", async () => {
    const { deps } = makeDeps({ context: null });
    const result = await applySourceImageCore(POST_ID, USER_ID, false, deps);
    assert.equal(result.success === false && result.code, "NOT_FOUND");
  });
});

// ─── Access control ───────────────────────────────────────────────────────────

describe("useSourceImage — access control", () => {
  it("hides the post from a non-member behind NOT_FOUND", async () => {
    const { deps, log } = makeDeps({ role: null });
    const result = await applySourceImageCore(POST_ID, USER_ID, false, deps);
    assert.equal(result.success === false && result.code, "NOT_FOUND");
    assert.deepEqual(log.postWrites, []);
  });

  it("refuses a member whose role is neither owner nor editor", async () => {
    const { deps } = makeDeps({ role: "viewer" });
    const result = await applySourceImageCore(POST_ID, USER_ID, false, deps);
    assert.equal(result.success === false && result.code, "FORBIDDEN");
  });

  it("lets an owner through", async () => {
    const { deps } = makeDeps({ role: "owner" });
    assert.equal((await applySourceImageCore(POST_ID, USER_ID, false, deps)).success, true);
  });

  it("lets a global admin through without a membership", async () => {
    const { deps } = makeDeps({ role: null });
    assert.equal((await applySourceImageCore(POST_ID, USER_ID, true, deps)).success, true);
  });
});

// ─── Failures leave the post alone ────────────────────────────────────────────

describe("useSourceImage — failures never touch the post", () => {
  const failures = [
    ["a dead link", { success: false, code: "FETCH_FAILED", message: "gone" }, "FETCH_FAILED"],
    [
      "an HTML response",
      { success: false, code: "UNSUPPORTED_TYPE", message: "html" },
      "UNSUPPORTED_TYPE",
    ],
    [
      "an oversized file",
      { success: false, code: "IMAGE_TOO_LARGE", message: "big" },
      "IMAGE_TOO_LARGE",
    ],
    ["a blocked address", { success: false, code: "UNSAFE_URL", message: "private" }, "UNSAFE_URL"],
  ] as const;

  for (const [label, fetchResult, expected] of failures) {
    it(`reports ${label} and writes nothing`, async () => {
      const { deps, log } = makeDeps({
        fetchResult: fetchResult as Awaited<ReturnType<ApplySourceImageDeps["fetchImage"]>>,
      });
      const result = await applySourceImageCore(POST_ID, USER_ID, false, deps);

      assert.equal(result.success === false && result.code, expected);
      assert.deepEqual(log.postWrites, [], "the post still shows its AI image");
      assert.deepEqual(log.created, [], "no orphan MediaAsset row");
      assert.equal(log.uploads, 0);
    });
  }

  it("folds an empty body into FETCH_FAILED", async () => {
    const { deps } = makeDeps({
      fetchResult: { success: false, code: "EMPTY_IMAGE", message: "empty" },
    });
    const result = await applySourceImageCore(POST_ID, USER_ID, false, deps);
    assert.equal(result.success === false && result.code, "FETCH_FAILED");
  });

  it("reports a Cloudinary failure and leaves the post on its current image", async () => {
    const { deps, log } = makeDeps({
      uploadResult: { success: false, message: "Cloudinary is down" },
    });
    const result = await applySourceImageCore(POST_ID, USER_ID, false, deps);

    assert.equal(result.success === false && result.code, "UPLOAD_FAILED");
    assert.equal(result.success === false && result.message, "Cloudinary is down");
    assert.deepEqual(log.postWrites, []);
    assert.deepEqual(log.created, [], "an asset row is only written after a successful upload");
  });
});
