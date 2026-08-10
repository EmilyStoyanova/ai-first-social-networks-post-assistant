import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  restorePreviousImageCore,
  type PreviousImageContext,
  type RestorePreviousImageDeps,
} from "./restore-previous-image.service";
import type { PostImageDTO } from "./apply-source-image.service";

const POST_ID = "post-1";
const USER_ID = "user-1";
const COMPANY_ID = "company-1";

const AI_ASSET: PostImageDTO = {
  id: "asset-ai",
  url: "https://res.cloudinary.com/x/ai.png",
  width: 1200,
  height: 632,
};
const SOURCE_ASSET_ID = "asset-source";

interface Recorder {
  postWrites: Array<{ mediaAssetId: string; previousMediaAssetId: string | null }>;
  audits: number;
}

function makeDeps(
  overrides: { context?: Partial<PreviousImageContext> | null; role?: string | null } = {}
): { deps: RestorePreviousImageDeps; log: Recorder } {
  const log: Recorder = { postWrites: [], audits: 0 };

  const context: PreviousImageContext | null =
    overrides.context === null
      ? null
      : {
          companyId: COMPANY_ID,
          mediaAssetId: SOURCE_ASSET_ID,
          previous: AI_ASSET,
          ...overrides.context,
        };

  const deps: RestorePreviousImageDeps = {
    loadContext: async () => context,
    loadRole: async () => (overrides.role === undefined ? "editor" : overrides.role),
    setPostImage: async (_postId, mediaAssetId, previousMediaAssetId) => {
      log.postWrites.push({ mediaAssetId, previousMediaAssetId });
    },
    audit: async () => {
      log.audits++;
    },
  };

  return { deps, log };
}

describe("usePreviousImage — switching back to the AI image", () => {
  it("restores the preserved asset without regenerating anything", async () => {
    const { deps, log } = makeDeps();
    const result = await restorePreviousImageCore(POST_ID, USER_ID, false, deps);

    assert.equal(result.success, true);
    assert.equal(result.success && result.media.id, AI_ASSET.id);
    assert.equal(log.postWrites.length, 1);
    assert.equal(log.postWrites[0].mediaAssetId, AI_ASSET.id);
    assert.equal(log.audits, 1);
  });

  it("swaps symmetrically, so the article image becomes the new fallback", async () => {
    // This is what lets the user flip back and forth indefinitely; both assets
    // survive every switch.
    const { deps, log } = makeDeps();
    await restorePreviousImageCore(POST_ID, USER_ID, false, deps);
    assert.equal(log.postWrites[0].previousMediaAssetId, SOURCE_ASSET_ID);
  });

  it("refuses when the post has never been switched", async () => {
    const { deps, log } = makeDeps({ context: { previous: null } });
    const result = await restorePreviousImageCore(POST_ID, USER_ID, false, deps);

    assert.equal(result.success === false && result.code, "NO_PREVIOUS_IMAGE");
    assert.deepEqual(log.postWrites, []);
  });

  it("returns NOT_FOUND for a post that does not exist", async () => {
    const { deps } = makeDeps({ context: null });
    const result = await restorePreviousImageCore(POST_ID, USER_ID, false, deps);
    assert.equal(result.success === false && result.code, "NOT_FOUND");
  });
});

describe("usePreviousImage — access control", () => {
  it("hides the post from a non-member behind NOT_FOUND", async () => {
    const { deps, log } = makeDeps({ role: null });
    const result = await restorePreviousImageCore(POST_ID, USER_ID, false, deps);
    assert.equal(result.success === false && result.code, "NOT_FOUND");
    assert.deepEqual(log.postWrites, []);
  });

  it("refuses a role that is neither owner nor editor", async () => {
    const { deps } = makeDeps({ role: "viewer" });
    const result = await restorePreviousImageCore(POST_ID, USER_ID, false, deps);
    assert.equal(result.success === false && result.code, "FORBIDDEN");
  });

  it("lets a global admin through without a membership", async () => {
    const { deps } = makeDeps({ role: null });
    assert.equal((await restorePreviousImageCore(POST_ID, USER_ID, true, deps)).success, true);
  });
});
