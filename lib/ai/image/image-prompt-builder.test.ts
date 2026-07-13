import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildImagePrompt } from "./image-prompt-builder";
import { IMAGE_STYLE_INSTRUCTIONS } from "./image-style";

const BASE = {
  basePrompt: "A cup of coffee on a wooden desk",
  channel: "instagram",
  forbiddenWords: [] as string[],
};

describe("buildImagePrompt — image style", () => {
  it("realistic style appends the realistic instruction", () => {
    const prompt = buildImagePrompt({ ...BASE, imageStyle: "realistic" });
    assert.ok(
      prompt.includes(IMAGE_STYLE_INSTRUCTIONS.realistic),
      "prompt should contain the realistic style instruction"
    );
    assert.ok(!prompt.includes(IMAGE_STYLE_INSTRUCTIONS.animated));
  });

  it("animated style appends the animated instruction", () => {
    const prompt = buildImagePrompt({ ...BASE, imageStyle: "animated" });
    assert.ok(
      prompt.includes(IMAGE_STYLE_INSTRUCTIONS.animated),
      "prompt should contain the animated style instruction"
    );
    assert.ok(!prompt.includes(IMAGE_STYLE_INSTRUCTIONS.realistic));
  });

  it("animated style does not contain the conflicting 'Photorealistic' wording", () => {
    const prompt = buildImagePrompt({ ...BASE, imageStyle: "animated" });
    assert.ok(
      !prompt.includes("Photorealistic"),
      "animated prompt must not describe the image as Photorealistic"
    );
    // Other safety instructions are still present.
    assert.ok(prompt.includes("No text overlays."));
    assert.ok(prompt.includes("No logos or watermarks."));
    assert.ok(prompt.includes("No faces."));
    assert.ok(prompt.includes("social-media-optimized."));
  });

  it("default style produces output identical to omitting the style", () => {
    const legacy = buildImagePrompt({ ...BASE });
    const withDefault = buildImagePrompt({ ...BASE, imageStyle: "default" });
    assert.equal(withDefault, legacy, "default must preserve the legacy prompt exactly");
    assert.ok(!legacy.includes(IMAGE_STYLE_INSTRUCTIONS.realistic));
    assert.ok(!legacy.includes(IMAGE_STYLE_INSTRUCTIONS.animated));
  });

  it("omitting the style leaves the channel hints and safety suffix intact", () => {
    const prompt = buildImagePrompt({ ...BASE });
    assert.ok(prompt.startsWith(BASE.basePrompt));
    assert.ok(prompt.includes("Format: square 1:1 format."));
    assert.ok(prompt.includes("No text overlays."));
  });
});
