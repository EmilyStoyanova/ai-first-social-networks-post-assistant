import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildImagePrompt,
  QUALITY_SUFFIX,
  PEOPLE_QUALITY_SUFFIX,
  NEGATIVE_PROMPT_BASE,
  NEGATIVE_PROMPT_PEOPLE,
  NEGATIVE_PROMPT_NO_PEOPLE,
} from "./image-prompt-builder";
import { IMAGE_STYLE_INSTRUCTIONS } from "./image-style";

const BASE = {
  basePrompt: "A cup of coffee on a wooden desk",
  channel: "instagram",
  forbiddenWords: [] as string[],
};

const PEOPLE_SCENE = "A developer presenting to a small team in a bright office";

describe("buildImagePrompt — image style", () => {
  it("realistic style appends the realistic instruction", () => {
    const { prompt } = buildImagePrompt({ ...BASE, imageStyle: "realistic" });
    assert.ok(
      prompt.includes(IMAGE_STYLE_INSTRUCTIONS.realistic),
      "prompt should contain the realistic style instruction"
    );
    assert.ok(!prompt.includes(IMAGE_STYLE_INSTRUCTIONS.animated));
  });

  it("animated style appends the animated instruction", () => {
    const { prompt } = buildImagePrompt({ ...BASE, imageStyle: "animated" });
    assert.ok(
      prompt.includes(IMAGE_STYLE_INSTRUCTIONS.animated),
      "prompt should contain the animated style instruction"
    );
    assert.ok(!prompt.includes(IMAGE_STYLE_INSTRUCTIONS.realistic));
  });

  it("animated style does not contain the conflicting 'Photorealistic' wording", () => {
    const { prompt } = buildImagePrompt({ ...BASE, imageStyle: "animated" });
    assert.ok(
      !prompt.includes("Photorealistic"),
      "animated prompt must not describe the image as Photorealistic"
    );
    assert.ok(prompt.includes("social-media-optimized."));
  });

  it("default style produces output identical to omitting the style", () => {
    const legacy = buildImagePrompt({ ...BASE });
    const withDefault = buildImagePrompt({ ...BASE, imageStyle: "default" });
    assert.deepEqual(withDefault, legacy, "default must preserve the legacy prompt exactly");
    assert.ok(!legacy.prompt.includes(IMAGE_STYLE_INSTRUCTIONS.realistic));
    assert.ok(!legacy.prompt.includes(IMAGE_STYLE_INSTRUCTIONS.animated));
  });

  it("omitting the style leaves the channel hints intact", () => {
    const { prompt } = buildImagePrompt({ ...BASE });
    assert.ok(prompt.startsWith(BASE.basePrompt));
    assert.ok(prompt.includes("Format: square 1:1 format."));
    assert.ok(prompt.includes("Style: vibrant colors, lifestyle aesthetic, visually striking."));
  });
});

// ─── Shared image-quality guidance ────────────────────────────────────────────

describe("buildImagePrompt — shared quality suffix", () => {
  it("applies to every style, including the default the automatic path uses", () => {
    for (const imageStyle of ["default", "realistic", "animated"] as const) {
      assert.ok(
        buildImagePrompt({ ...BASE, imageStyle }).prompt.includes(QUALITY_SUFFIX),
        `quality guidance missing for the ${imageStyle} style`
      );
    }
    // Automatic generation calls the pipeline with no style at all.
    assert.ok(buildImagePrompt({ ...BASE }).prompt.includes(QUALITY_SUFFIX));
  });

  it("applies on every channel, and on a channel with no hints of its own", () => {
    for (const channel of ["instagram", "linkedin", "facebook", "tiktok", "mastodon"]) {
      assert.ok(
        buildImagePrompt({ ...BASE, channel }).prompt.includes(QUALITY_SUFFIX),
        `quality guidance missing for ${channel}`
      );
    }
  });

  it("does not force photorealism — nothing in it names a medium", () => {
    for (const banned of ["photo", "photograph", "photorealistic", "realistic", "camera", "lens"]) {
      assert.ok(
        !QUALITY_SUFFIX.toLowerCase().includes(banned),
        `quality guidance must not mention "${banned}" — it would fight the animated style`
      );
    }
    // The animated prompt as a whole still carries no realism wording.
    const animated = buildImagePrompt({ ...BASE, imageStyle: "animated" });
    assert.ok(!animated.prompt.includes("Photorealistic"));
    assert.ok(animated.prompt.includes(IMAGE_STYLE_INSTRUCTIONS.animated));
    // ...and excluding defects must not sneak realism in through the back door.
    assert.ok(!animated.negativePrompt.toLowerCase().includes("cartoon"));
    assert.ok(!animated.negativePrompt.toLowerCase().includes("illustration"));
    assert.ok(!animated.negativePrompt.toLowerCase().includes("anime"));
  });

  it("states qualities to produce, never defects to avoid", () => {
    const text = `${QUALITY_SUFFIX} ${PEOPLE_QUALITY_SUFFIX}`.toLowerCase();
    for (const negation of ["no ", "not ", "without", "avoid", "deformed", "extra fingers"]) {
      assert.ok(
        !text.includes(negation),
        `quality guidance must stay positive — found "${negation}"`
      );
    }
  });

  it("keeps the base prompt first and adds the guidance once", () => {
    const { prompt } = buildImagePrompt({ ...BASE });
    assert.ok(prompt.startsWith(BASE.basePrompt));
    assert.equal(prompt.split(QUALITY_SUFFIX).length - 1, 1);
  });

  it("survives the forbidden-word filter, which only strips the base prompt", () => {
    // "clean" and "sharp" appear in the quality guidance; stripping them there
    // would quietly disarm it for any brand that bans a common adjective.
    const { prompt } = buildImagePrompt({
      ...BASE,
      basePrompt: "A clean sharp cup of coffee",
      forbiddenWords: ["clean", "sharp"],
    });
    assert.ok(prompt.includes(QUALITY_SUFFIX));
    assert.ok(prompt.startsWith("A cup of coffee"));
  });
});

describe("buildImagePrompt — anatomy guidance for scenes with people", () => {
  it("is added when the scene contains people, in any style", () => {
    for (const imageStyle of ["default", "realistic", "animated"] as const) {
      const { prompt } = buildImagePrompt({ ...BASE, basePrompt: PEOPLE_SCENE, imageStyle });
      assert.ok(prompt.includes(PEOPLE_QUALITY_SUFFIX), `missing for the ${imageStyle} style`);
      assert.ok(prompt.includes(QUALITY_SUFFIX), "general quality guidance is still present");
    }
  });

  it("is left out of a scene with nobody in it", () => {
    const { prompt } = buildImagePrompt({ ...BASE });
    assert.ok(!prompt.includes(PEOPLE_QUALITY_SUFFIX));
    assert.ok(prompt.includes(QUALITY_SUFFIX), "general quality guidance still applies");
  });

  it("matches whole words only, case-insensitively, singular and plural", () => {
    const withPeople = [
      "A Woman reading a book",
      "Two women at a whiteboard",
      "Close-up of hands typing",
      "Portrait of a founder",
      "Children playing outdoors",
      "A crowd at a conference",
    ];
    for (const basePrompt of withPeople) {
      assert.ok(
        buildImagePrompt({ ...BASE, basePrompt }).prompt.includes(PEOPLE_QUALITY_SUFFIX),
        `expected people guidance for: ${basePrompt}`
      );
    }
  });

  it("does not fire on words that merely contain a people word", () => {
    const withoutPeople = [
      "A management dashboard on a monitor",
      "A handful of coffee beans",
      "Manufacturing equipment in a warehouse",
      "A mannequin in a shop window",
    ];
    for (const basePrompt of withoutPeople) {
      assert.ok(
        !buildImagePrompt({ ...BASE, basePrompt }).prompt.includes(PEOPLE_QUALITY_SUFFIX),
        `unexpected people guidance for: ${basePrompt}`
      );
    }
  });

  it("reads the prompt AFTER forbidden-word removal", () => {
    // The only human reference is stripped, so the scene no longer has people
    // in it and anatomy guidance would describe someone who is not there.
    const { prompt } = buildImagePrompt({
      ...BASE,
      basePrompt: "A developer at a wooden desk",
      forbiddenWords: ["developer"],
    });
    assert.ok(!prompt.includes(PEOPLE_QUALITY_SUFFIX));
  });
});

// ─── Negative prompt ──────────────────────────────────────────────────────────

describe("buildImagePrompt — negative prompt", () => {
  it("returns a positive prompt and a non-empty negative prompt", () => {
    const built = buildImagePrompt({ ...BASE });
    assert.equal(typeof built.prompt, "string");
    assert.equal(typeof built.negativePrompt, "string");
    assert.ok(built.prompt.length > 0);
    assert.ok(built.negativePrompt.length > 0);
  });

  it("no longer carries the old negations in the positive prompt", () => {
    const cases = [
      buildImagePrompt({ ...BASE, imageStyle: "realistic" }),
      buildImagePrompt({ ...BASE, imageStyle: "animated" }),
      buildImagePrompt({ ...BASE, imageStyle: "default" }),
      buildImagePrompt({ ...BASE, basePrompt: PEOPLE_SCENE }),
    ];
    for (const { prompt } of cases) {
      for (const gone of ["No text overlays.", "No logos or watermarks.", "No faces."]) {
        assert.ok(!prompt.includes(gone), `"${gone}" must no longer be in the positive prompt`);
      }
    }
  });

  it("covers the shared defect terms on every image", () => {
    const { negativePrompt } = buildImagePrompt({ ...BASE, imageStyle: "animated" });
    for (const term of [
      "deformed anatomy",
      "floating or intersecting objects",
      "distorted perspective",
      "blurry",
      "low quality",
      "text",
      "watermark",
      "logo",
    ]) {
      assert.ok(negativePrompt.includes(term), `negative prompt should exclude "${term}"`);
    }
    assert.ok(negativePrompt.includes(NEGATIVE_PROMPT_BASE));
  });

  it("excludes anatomy defects only when the scene contains people", () => {
    const people = buildImagePrompt({ ...BASE, basePrompt: PEOPLE_SCENE });
    assert.ok(people.negativePrompt.includes(NEGATIVE_PROMPT_PEOPLE));
    for (const term of [
      "malformed face",
      "asymmetrical or misaligned eyes",
      "bad hands",
      "extra or missing fingers",
      "fused or malformed fingers",
      "extra or duplicated limbs",
      "duplicated people",
    ]) {
      assert.ok(people.negativePrompt.includes(term), `expected "${term}"`);
    }

    const objects = buildImagePrompt({ ...BASE });
    assert.ok(!objects.negativePrompt.includes(NEGATIVE_PROMPT_PEOPLE));
  });

  it("never forbids faces on a scene that is supposed to have people", () => {
    const { prompt, negativePrompt } = buildImagePrompt({ ...BASE, basePrompt: PEOPLE_SCENE });
    assert.ok(
      !negativePrompt.includes(NEGATIVE_PROMPT_NO_PEOPLE),
      "a people scene must not exclude people or faces wholesale"
    );
    // We ask for good faces instead of forbidding them.
    assert.ok(prompt.includes("natural facial features"));
  });

  it("keeps stray people out of an object scene, where 'No faces.' used to", () => {
    const { negativePrompt } = buildImagePrompt({ ...BASE });
    assert.ok(negativePrompt.includes(NEGATIVE_PROMPT_NO_PEOPLE));
  });

  it("is identical across styles for the same scene — it describes defects, not a look", () => {
    const realistic = buildImagePrompt({ ...BASE, imageStyle: "realistic" });
    const animated = buildImagePrompt({ ...BASE, imageStyle: "animated" });
    assert.equal(realistic.negativePrompt, animated.negativePrompt);
  });
});
