import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generatePostImageCore } from "./generate-post-image.service";
import type { GeneratePostImageDb, GeneratePostImageDeps } from "./generate-post-image.service";
import type { IImageProvider } from "@/lib/ai/image/image-provider";
import { IMAGE_STYLE_INSTRUCTIONS } from "@/lib/ai/image/image-style";

type CreateArgs = Parameters<GeneratePostImageDb["mediaAsset"]["create"]>[0];

function makeDeps(): {
  deps: GeneratePostImageDeps;
  created: () => CreateArgs["data"] | null;
  generatedPrompt: () => string | null;
} {
  let createdData: CreateArgs["data"] | null = null;
  let prompt: string | null = null;

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
      findFirst: async () => ({ role: "owner" }),
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
  };
}

describe("generatePostImageCore — image style persistence", () => {
  it("saves the selected style on the MediaAsset", async () => {
    const { deps, created } = makeDeps();
    const result = await generatePostImageCore("post-1", "u-1", false, "realistic", deps);
    assert.ok(result.success);
    assert.equal(created()?.imageStyle, "realistic");
  });

  it("stores null when no style is selected", async () => {
    const { deps, created } = makeDeps();
    const result = await generatePostImageCore("post-1", "u-1", false, undefined, deps);
    assert.ok(result.success);
    assert.equal(created()?.imageStyle, null);
  });

  it("threads the style into the generated prompt", async () => {
    const { deps, generatedPrompt } = makeDeps();
    await generatePostImageCore("post-1", "u-1", false, "animated", deps);
    assert.ok(generatedPrompt()?.includes(IMAGE_STYLE_INSTRUCTIONS.animated));
  });
});
