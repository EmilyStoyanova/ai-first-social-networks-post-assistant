import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generatePostImageCore } from "./generate-post-image.service";
import type { GeneratePostImageDb, GeneratePostImageDeps } from "./generate-post-image.service";
import type { IImageProvider } from "@/lib/ai/image/image-provider";
import { IMAGE_STYLE_INSTRUCTIONS } from "@/lib/ai/image/image-style";

type CreateArgs = Parameters<GeneratePostImageDb["mediaAsset"]["create"]>[0];

/** The manual actor used by the pre-existing style tests. */
const USER_ACTOR = { kind: "user", userId: "u-1", isGlobalAdmin: false } as const;

function makeDeps(): {
  deps: GeneratePostImageDeps;
  created: () => CreateArgs["data"] | null;
  generatedPrompt: () => string | null;
  membershipChecked: () => boolean;
} {
  let createdData: CreateArgs["data"] | null = null;
  let prompt: string | null = null;
  let checkedMembership = false;

  const provider: IImageProvider = {
    async generate(p) {
      prompt = p;
      return {
        url: "https://cdn.example/x.png",
        width: 1080,
        height: 1080,
        providerAssetId: "prov-1",
      };
    },
  };

  const db: GeneratePostImageDb = {
    post: {
      findUnique: async () => ({
        companyId: "co-1",
        channel: "instagram",
        imagePrompt: "A coffee cup",
        company: { brandGuidelines: { forbiddenWords: [] } },
      }),
      update: async () => ({}),
    },
    companyMember: {
      findFirst: async () => {
        checkedMembership = true;
        return { role: "owner" };
      },
    },
    mediaAsset: {
      create: async (args) => {
        createdData = args.data;
        return {
          id: "asset-1",
          url: args.data.url,
          width: args.data.width,
          height: args.data.height,
        };
      },
    },
  };

  return {
    deps: { db, getProvider: () => provider },
    created: () => createdData,
    generatedPrompt: () => prompt,
    membershipChecked: () => checkedMembership,
  };
}

describe("generatePostImageCore — image style persistence", () => {
  it("saves the selected style on the MediaAsset", async () => {
    const { deps, created } = makeDeps();
    const result = await generatePostImageCore("post-1", USER_ACTOR, "realistic", deps);
    assert.ok(result.success);
    assert.equal(created()?.imageStyle, "realistic");
  });

  it("stores null when no style is selected", async () => {
    const { deps, created } = makeDeps();
    const result = await generatePostImageCore("post-1", USER_ACTOR, undefined, deps);
    assert.ok(result.success);
    assert.equal(created()?.imageStyle, null);
  });

  it("threads the style into the generated prompt", async () => {
    const { deps, generatedPrompt } = makeDeps();
    await generatePostImageCore("post-1", USER_ACTOR, "animated", deps);
    assert.ok(generatedPrompt()?.includes(IMAGE_STYLE_INSTRUCTIONS.animated));
  });
});

describe("generatePostImageCore — prompt override", () => {
  it("uses a non-empty override instead of the post's stored prompt", async () => {
    const { deps, generatedPrompt } = makeDeps();
    await generatePostImageCore("post-1", USER_ACTOR, undefined, deps, "A neon skyline");
    assert.ok(generatedPrompt()?.includes("A neon skyline"));
    assert.ok(!generatedPrompt()?.includes("A coffee cup"));
  });

  it("records the override in the MediaAsset's aiPrompt", async () => {
    const { deps, created } = makeDeps();
    await generatePostImageCore("post-1", USER_ACTOR, undefined, deps, "A neon skyline");
    assert.ok(created()?.aiPrompt.includes("A neon skyline"));
  });

  it("falls back to the post's prompt when the override is blank", async () => {
    const { deps, generatedPrompt } = makeDeps();
    await generatePostImageCore("post-1", USER_ACTOR, undefined, deps, "   ");
    assert.ok(generatedPrompt()?.includes("A coffee cup"));
  });
});

describe("generatePostImageCore — actor", () => {
  it("re-checks membership for a non-admin user", async () => {
    const { deps, membershipChecked } = makeDeps();
    await generatePostImageCore("post-1", USER_ACTOR, undefined, deps);
    assert.equal(membershipChecked(), true);
  });

  it("skips the membership check for a system actor and attributes the asset to it", async () => {
    const { deps, membershipChecked, created } = makeDeps();
    const result = await generatePostImageCore(
      "post-1",
      { kind: "system", attributeToUserId: "creator-9" },
      undefined,
      deps
    );

    assert.ok(result.success);
    // A cron run has no user whose membership could be checked.
    assert.equal(membershipChecked(), false);
    assert.equal(created()?.uploadedBy, "creator-9");
  });
});
