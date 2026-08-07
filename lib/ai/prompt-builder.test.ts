import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPrompts, buildRetryUserPrompt } from "./prompt-builder";
import { CHANNEL_POLICIES } from "./channel-policy";
import type { BrandContext, FeedItemContext, GenerationContext } from "./types";

function makeCtx(overrides: {
  imageRequired?: boolean;
  postingLanguage?: string;
  channel?: string;
}): GenerationContext {
  return {
    company: {
      name: "Acme",
      website: null,
      automationMode: "semi_automated",
      defaultLang: "en",
    },
    brand: null,
    channel: {
      channel: overrides.channel ?? "instagram",
      postingLanguage: overrides.postingLanguage ?? "en",
      imageRequired: overrides.imageRequired ?? false,
      automationModeOverride: null,
      maxTextLength: null,
      includeSourceLink: false,
      // Not read by the prompt builder — image generation happens after the post.
      autoGenerateImage: false,
    },
    feedItems: [],
    hasArticleSources: false,
  };
}

function makeBrand(overrides: Partial<BrandContext> = {}): BrandContext {
  return {
    companyDescription: null,
    toneOfVoice: null,
    targetAudience: null,
    forbiddenWords: [],
    competitors: [],
    primaryColor: null,
    secondaryColor: null,
    ...overrides,
  };
}

/** A context whose brand carries the given competitors (null = no brand row). */
function ctxWithCompetitors(competitors: string[] | null): GenerationContext {
  return {
    ...makeCtx({}),
    brand: competitors === null ? null : makeBrand({ competitors }),
  };
}

const COMPETITOR_INSTRUCTION =
  "Use the listed competitors only as positioning context. Create distinct content that reflects the company’s own brand, strengths, and tone. Do not imitate competitors, make unsupported comparisons, or mention them unless the source content explicitly requires it.";

describe("prompt-builder — Bulgarian content language", () => {
  it("instructs the LLM to write post text in Bulgarian", () => {
    const { systemPrompt } = buildPrompts(makeCtx({}), null, "bg");
    assert.ok(systemPrompt.includes("Bulgarian"), "system prompt should mention Bulgarian");
    assert.ok(
      systemPrompt.includes("text") && systemPrompt.includes("BG"),
      "writing rule should scope BG to the text field"
    );
  });

  it("instructs imagePrompt to always be in English even when contentLanguage=bg", () => {
    const { systemPrompt, userPrompt } = buildPrompts(makeCtx({}), null, "bg");
    const combined = systemPrompt + "\n" + userPrompt;
    assert.ok(
      combined.toLowerCase().includes("english"),
      "prompts must explicitly require imagePrompt to be in English"
    );
    assert.ok(
      combined.includes("imagePrompt") && combined.toLowerCase().includes("english"),
      "imagePrompt English rule must be present"
    );
  });

  it("imagePrompt English rule is present even when contentLanguage=en", () => {
    const { systemPrompt, userPrompt } = buildPrompts(makeCtx({}), null, "en");
    const combined = systemPrompt + "\n" + userPrompt;
    assert.ok(
      combined.toLowerCase().includes("english"),
      "imagePrompt English rule should always appear"
    );
  });
});

describe("prompt-builder — competitor positioning", () => {
  it("adds the competitor section when the brand lists competitors", () => {
    const { systemPrompt } = buildPrompts(ctxWithCompetitors(["Globex", "Initech"]), null);

    assert.ok(
      systemPrompt.includes("## Competitor Positioning"),
      "system prompt must carry the competitor section heading"
    );
    assert.ok(
      systemPrompt.includes(COMPETITOR_INSTRUCTION),
      "the positioning instruction must be sent verbatim"
    );
  });

  it("lists every competitor name below the instruction", () => {
    const { systemPrompt } = buildPrompts(ctxWithCompetitors(["Globex", "Initech"]), null);

    assert.ok(systemPrompt.includes("Competitors:\n- Globex\n- Initech"));
    // Order matters only in that the names must follow the rule that governs
    // them — a list ahead of its instruction invites comparison writing.
    assert.ok(
      systemPrompt.indexOf(COMPETITOR_INSTRUCTION) < systemPrompt.indexOf("- Globex"),
      "the instruction must precede the names"
    );
  });

  it("omits the section entirely when the competitor list is empty", () => {
    const { systemPrompt } = buildPrompts(ctxWithCompetitors([]), null);

    assert.ok(
      !systemPrompt.includes("Competitor Positioning"),
      "an empty list must add no heading"
    );
    assert.ok(!systemPrompt.includes("Competitors:"));
  });

  it("omits the section when the company has no brand guidelines row", () => {
    const { systemPrompt } = buildPrompts(ctxWithCompetitors(null), null);

    assert.ok(!systemPrompt.includes("Competitor Positioning"));
  });

  it("handles a single competitor", () => {
    const { systemPrompt } = buildPrompts(ctxWithCompetitors(["Globex"]), null);

    assert.ok(systemPrompt.includes("Competitors:\n- Globex"));
  });

  it("keeps competitors out of the user prompt", () => {
    const ctx = ctxWithCompetitors(["Globex"]);
    const { userPrompt } = buildPrompts(ctx, null);

    assert.ok(!userPrompt.includes("Globex"));
    assert.ok(!userPrompt.includes("Competitor Positioning"));
  });

  it("forbids naming a brand in the scene, since the Image Prompt section shares a message with the competitor list", () => {
    // Image generation must never receive competitor names — a brand name in a
    // visual prompt invites logo and style imitation. The imagePrompt rules now
    // sit in the system prompt, next to the competitor names themselves, so the
    // separation has to be stated rather than come from being in another message.
    const { systemPrompt } = buildPrompts(ctxWithCompetitors(["Globex"]), null);

    assert.ok(systemPrompt.includes("## Image Prompt"));
    assert.ok(systemPrompt.includes("Never name a company, brand, or competitor in the scene."));
  });

  it("leaves the rest of the system prompt intact", () => {
    const withCompetitors = buildPrompts(ctxWithCompetitors(["Globex"]), null).systemPrompt;
    const without = buildPrompts(ctxWithCompetitors([]), null).systemPrompt;

    // Everything the section is inserted between must still be there.
    for (const marker of ["## Company", "## Channel:", "## Writing Rules", "## Core Message"]) {
      assert.ok(withCompetitors.includes(marker), `${marker} must survive the insertion`);
      assert.ok(without.includes(marker));
    }
  });
});

describe("prompt-builder — Bulgarian language quality section", () => {
  it("includes the Bulgarian quality section when contentLanguage=bg", () => {
    const { systemPrompt } = buildPrompts(makeCtx({}), null, "bg");
    assert.ok(
      systemPrompt.includes("Bulgarian Language Quality"),
      "BG system prompt must include the quality section heading"
    );
    assert.ok(
      systemPrompt.includes("professional Bulgarian copywriter"),
      "BG system prompt must instruct writing as a professional Bulgarian copywriter"
    );
    assert.ok(
      systemPrompt.includes("Do NOT translate from English"),
      "BG system prompt must explicitly forbid translating from English"
    );
  });

  it("includes the Bulgarian quality section when channel postingLanguage=bg (no contentLanguage override)", () => {
    const { systemPrompt } = buildPrompts(makeCtx({ postingLanguage: "bg" }), null);
    assert.ok(
      systemPrompt.includes("Bulgarian Language Quality"),
      "BG channel language must also trigger the quality section"
    );
  });

  it("omits the Bulgarian quality section for English generation", () => {
    const { systemPrompt } = buildPrompts(makeCtx({}), null, "en");
    assert.ok(
      !systemPrompt.includes("Bulgarian Language Quality"),
      "EN system prompt must NOT include the BG quality section"
    );
    assert.ok(
      !systemPrompt.includes("professional Bulgarian copywriter"),
      "EN system prompt must NOT mention Bulgarian copywriting rules"
    );
  });

  it("omits the Bulgarian quality section when no contentLanguage override and channel is EN", () => {
    const { systemPrompt } = buildPrompts(makeCtx({ postingLanguage: "en" }), null);
    assert.ok(
      !systemPrompt.includes("Bulgarian Language Quality"),
      "default EN channel must NOT include BG quality section"
    );
  });

  it("BG prompt retains the basic language directive in Writing Rules", () => {
    const { systemPrompt } = buildPrompts(makeCtx({}), null, "bg");
    assert.ok(
      systemPrompt.includes("Generate the post in Bulgarian."),
      "Writing Rules must still include the basic BG language directive"
    );
  });

  it("EN prompt Writing Rules language directive is unchanged", () => {
    const { systemPrompt } = buildPrompts(makeCtx({}), null, "en");
    assert.ok(
      systemPrompt.includes("Generate the post in English."),
      "EN Writing Rules language directive must remain unchanged"
    );
    assert.ok(
      !systemPrompt.includes("Generate the post in Bulgarian"),
      "EN system prompt must not mention Bulgarian directive"
    );
  });

  it("BG quality section does not appear in the user prompt", () => {
    const { userPrompt } = buildPrompts(makeCtx({}), null, "bg");
    assert.ok(
      !userPrompt.includes("Bulgarian Language Quality"),
      "BG quality section must only appear in the system prompt, not the user prompt"
    );
  });
});

describe("prompt-builder — coreMessage", () => {
  it("defines coreMessage in the system prompt with its constraints", () => {
    const { systemPrompt } = buildPrompts(makeCtx({}), null, "en");
    assert.ok(
      systemPrompt.includes("Core Message"),
      "system prompt must include the Core Message section"
    );
    assert.ok(
      systemPrompt.includes("exactly one sentence"),
      "coreMessage must be defined as exactly one sentence"
    );
    assert.ok(
      systemPrompt.includes("independent of the hook") || systemPrompt.includes("stand on its own"),
      "coreMessage must be defined as independent of the hook / CTA"
    );
    assert.ok(
      systemPrompt.includes("NOT a summary") && systemPrompt.includes("NOT the topic"),
      "coreMessage must be defined as neither a summary nor the topic"
    );
  });

  it("includes coreMessage in the JSON format block of the user prompt", () => {
    const { userPrompt } = buildPrompts(makeCtx({}), null, "en");
    const coreLine = userPrompt.split("\n").find((l) => l.includes('"coreMessage"'));
    assert.ok(coreLine, "JSON format block must include a coreMessage line");
    assert.ok(
      coreLine.toLowerCase().includes("one sentence"),
      "coreMessage JSON line should describe it as one sentence"
    );
  });

  it("instructs coreMessage to be written in the post language (BG)", () => {
    const { systemPrompt } = buildPrompts(makeCtx({}), null, "bg");
    // The Core Message section references the post language token (BG).
    const idx = systemPrompt.indexOf("Core Message");
    const section = systemPrompt.slice(idx);
    assert.ok(
      section.includes("BG"),
      "coreMessage rule must scope the language to BG for Bulgarian posts"
    );
  });
});

describe("prompt-builder — channel policy (v2-3)", () => {
  // The v2-3 refactor moved channel guidance into CHANNEL_POLICIES. It must not
  // change what the model receives, so these lock the rendered block to the
  // exact pre-refactor CHANNEL_RULES text. If a hint's wording or order changes,
  // generation changes — that should be a deliberate edit, not a silent one.
  const LEGACY_INSTAGRAM_BLOCK = [
    "## Channel: Instagram",
    "Write a visual-first, energetic caption.",
    "First 125 characters must be compelling (shown before 'more').",
    "Use emojis freely to enhance the message.",
    "Include 5–10 relevant hashtags at the end on a new line.",
    "Maximum caption length: 400 characters (excluding hashtags).",
    "Image required: No.",
    "Post language: EN",
  ].join("\n");

  const LEGACY_FACEBOOK_BLOCK = [
    "## Channel: Facebook",
    "Write a conversational, engaging post.",
    "Ideal length: 40–250 characters. Maximum: 500 characters.",
    "Emojis are welcome but use sparingly.",
    "Include 1–3 relevant hashtags at the end if they add value.",
    "Image required: No.",
    "Post language: EN",
  ].join("\n");

  it("renders the Instagram channel block byte-identically to pre-v2-3", () => {
    const { systemPrompt } = buildPrompts(makeCtx({ channel: "instagram" }), null, "en");
    assert.ok(
      systemPrompt.includes(LEGACY_INSTAGRAM_BLOCK),
      "Instagram channel block changed — generation behaviour would change"
    );
  });

  it("renders the Facebook channel block byte-identically to pre-v2-3", () => {
    const { systemPrompt } = buildPrompts(makeCtx({ channel: "facebook" }), null, "en");
    assert.ok(
      systemPrompt.includes(LEGACY_FACEBOOK_BLOCK),
      "Facebook channel block changed — generation behaviour would change"
    );
  });

  it("injects every hint fragment for the channel", () => {
    for (const channel of ["facebook", "linkedin", "instagram", "tiktok"] as const) {
      const { systemPrompt } = buildPrompts(makeCtx({ channel }), null, "en");
      for (const hint of CHANNEL_POLICIES[channel].hints) {
        assert.ok(
          systemPrompt.includes(hint.promptFragment),
          `${channel}: system prompt missing hint ${hint.id}`
        );
      }
    }
  });

  it("BLOCKING constraints contribute no prompt text — they block instead", () => {
    for (const channel of ["instagram", "tiktok"] as const) {
      const { systemPrompt, userPrompt } = buildPrompts(makeCtx({ channel }), null, "en");
      const combined = systemPrompt + "\n" + userPrompt;
      for (const constraint of CHANNEL_POLICIES[channel].constraints) {
        assert.ok(
          !combined.includes(constraint.description),
          `${channel}: constraint ${constraint.id} leaked into the prompt`
        );
      }
    }
  });

  it("an unknown channel yields no channel guidance rather than throwing", () => {
    const { systemPrompt } = buildPrompts(makeCtx({ channel: "myspace" }), null, "en");
    assert.ok(systemPrompt.includes("## Channel: myspace"));
    assert.ok(systemPrompt.includes("Post language: EN"));
  });
});

// ─── Primary source rendering ─────────────────────────────────────────────────
//
// A calendar event reached the model as its raw stored JSON, under a heading
// calling it an "article" and promising a link that is never attached. With a
// null description that left almost nothing to write about, and generation
// drifted onto unrelated company/brand themes.

describe("prompt-builder — calendar event as primary source", () => {
  const EVENT_TITLE = "DEV.BG All in One 2026";
  const EVENT_DESCRIPTION =
    "Bulgaria's largest IT conference — AI, software engineering and career tracks across six halls.";

  function eventItem(description: string | null): FeedItemContext {
    // Exactly what ingestion writes for a calendar_event source.
    return {
      id: "event-item-1",
      title: EVENT_TITLE,
      content: JSON.stringify({ title: EVENT_TITLE, date: "2026-08-29", description }),
      url: "event:src-cal",
      publishedAt: new Date("2026-08-29T00:00:00.000Z"),
      sourceType: "calendar_event",
      sourceName: "DEV.BG events",
      consumable: false,
    };
  }

  function eventPrompt(description: string | null): string {
    const primary = eventItem(description);
    const ctx = { ...makeCtx({ channel: "facebook" }), feedItems: [primary] };
    return buildPrompts(ctx, primary, "bg").userPrompt;
  }

  it("carries the event title, date, and description into the prompt", () => {
    const userPrompt = eventPrompt(EVENT_DESCRIPTION);

    assert.ok(userPrompt.includes(EVENT_TITLE), "the event title must reach the model");
    assert.ok(userPrompt.includes("29.08.2026"), "the event date must reach the model");
    assert.ok(userPrompt.includes(EVENT_DESCRIPTION), "the event description must reach the model");
  });

  it("does not dump the stored JSON into the prompt", () => {
    const userPrompt = eventPrompt(EVENT_DESCRIPTION);

    assert.ok(!userPrompt.includes('{"title"'), "the raw JSON payload must not reach the model");
  });

  it("introduces it as an event rather than as an article", () => {
    const userPrompt = eventPrompt(EVENT_DESCRIPTION);

    assert.ok(userPrompt.includes("CALENDAR EVENT"));
    assert.ok(
      !userPrompt.includes("PRIMARY SOURCE ARTICLE"),
      "an event is not an article — the wrong label is what invited the wrong reading"
    );
  });

  it("promises no link for an event, whose url is a storage key", () => {
    const userPrompt = eventPrompt(EVENT_DESCRIPTION);

    assert.ok(
      !userPrompt.includes("A link to this exact article will be attached"),
      "no url is appended for a calendar event, so the prompt must not claim one"
    );
    assert.ok(!userPrompt.includes("event:src-cal"), "the synthetic url never reaches the model");
  });

  it("says so explicitly when the event has no description", () => {
    const userPrompt = eventPrompt(null);

    assert.ok(userPrompt.includes(EVENT_TITLE));
    assert.ok(userPrompt.includes("29.08.2026"));
    assert.ok(userPrompt.includes("No description was provided"));
    assert.ok(!userPrompt.includes("null"), "a null field must never surface as the word 'null'");
  });
});

describe("prompt-builder — other primary source kinds", () => {
  function primaryPrompt(primary: FeedItemContext): string {
    return buildPrompts({ ...makeCtx({}), feedItems: [primary] }, primary).userPrompt;
  }

  const article: FeedItemContext = {
    id: "rss-1",
    title: "Rates hold steady",
    content: "The central bank left rates unchanged for a third meeting.",
    url: "https://news.example.com/rates",
    publishedAt: null,
    sourceType: "rss",
    sourceName: "Econ Daily",
    consumable: true,
  };

  it("leaves the RSS article block byte-identical", () => {
    // Locked deliberately: this text drives every RSS and cron generation, and
    // a change here changes their output.
    assert.ok(
      primaryPrompt(article).includes(
        [
          "**PRIMARY SOURCE ARTICLE — the post MUST be based on THIS article and no other.**",
          "The topic, facts, and angle of the post must come from this article. A link to this exact article will be attached to the post, so the post text must be about it.",
          "---",
          "**Rates hold steady**",
          "The central bank left rates unchanged for a third meeting.",
          "---",
        ].join("\n")
      )
    );
  });

  it("renders a product page's stored fields, not its JSON", () => {
    const userPrompt = primaryPrompt({
      ...article,
      id: "pp-1",
      title: "Pro Plan",
      content: JSON.stringify({
        title: "Pro Plan",
        description: "Everything in Starter, plus SSO.",
        image: "https://cdn.example.com/og.png",
      }),
      url: "https://shop.example.com/pro-plan",
      sourceType: "product_page",
    });

    assert.ok(userPrompt.includes("Everything in Starter, plus SSO."));
    assert.ok(!userPrompt.includes('{"title"'));
    assert.ok(!userPrompt.includes("cdn.example.com"), "the image url is dropped");
    // A product page IS a linkable page, so it keeps the article framing.
    assert.ok(userPrompt.includes("PRIMARY SOURCE ARTICLE"));
  });

  it("introduces a prompt source as a brief and keeps its text verbatim", () => {
    const userPrompt = primaryPrompt({
      ...article,
      id: "prompt-1",
      title: "Weekly tip",
      content: "Share one concrete productivity tip.",
      url: "prompt:src-1",
      sourceType: "prompt",
      consumable: false,
    });

    assert.ok(userPrompt.includes("CONTENT BRIEF"));
    assert.ok(userPrompt.includes("Share one concrete productivity tip."));
    assert.ok(!userPrompt.includes("prompt:src-1"));
  });

  it("keeps background items readable too", () => {
    const primary = article;
    const background: FeedItemContext = {
      id: "event-bg",
      title: "DEV.BG All in One 2026",
      content: JSON.stringify({
        title: "DEV.BG All in One 2026",
        date: "2026-08-29",
        description: null,
      }),
      url: "event:src-cal",
      publishedAt: null,
      sourceType: "calendar_event",
      sourceName: "DEV.BG events",
      consumable: false,
    };

    const { userPrompt } = buildPrompts(
      { ...makeCtx({}), feedItems: [primary, background] },
      primary
    );

    assert.ok(userPrompt.includes("Additional background context"));
    assert.ok(userPrompt.includes("29.08.2026"));
    assert.ok(!userPrompt.includes('{"title"'));
  });
});

// ─── Image prompt instruction ─────────────────────────────────────────────────
//
// "concise English visual description" was the entire specification of the field,
// and it was answered literally: one generic stock-photo sentence per post, and
// so near-identical images. These lock the richer instruction in place.

describe("prompt-builder — imagePrompt instruction", () => {
  /** The `## Image Prompt` block on its own, up to the next `## ` heading. */
  function imageSection(systemPrompt: string): string {
    const start = systemPrompt.indexOf("## Image Prompt");
    assert.ok(start >= 0, "system prompt must carry the Image Prompt section");
    const rest = systemPrompt.slice(start + 1);
    const end = rest.indexOf("\n## ");
    return end === -1 ? rest : rest.slice(0, end);
  }

  function jsonImageLine(userPrompt: string): string {
    const line = userPrompt.split("\n").find((l) => l.includes('"imagePrompt"'));
    assert.ok(line, "JSON format block must include an imagePrompt line");
    return line;
  }

  it("adds a dedicated Image Prompt section to the system prompt", () => {
    const { systemPrompt } = buildPrompts(makeCtx({}), null, "en");
    assert.ok(systemPrompt.includes("## Image Prompt"));
    assert.ok(
      imageSection(systemPrompt).includes("image generation model"),
      "the section must say what the field is for"
    );
  });

  it("is present whether or not the channel requires an image", () => {
    // imagePrompt is accepted either way, and a post's stored prompt is what a
    // later manual generation uses — a bad one is not harmless just because the
    // channel did not demand it.
    for (const imageRequired of [true, false]) {
      const { systemPrompt } = buildPrompts(makeCtx({ imageRequired }), null, "en");
      assert.ok(
        systemPrompt.includes("## Image Prompt"),
        `missing for imageRequired=${imageRequired}`
      );
    }
  });

  it("no longer calls the imagePrompt concise, in the section or the JSON block", () => {
    for (const imageRequired of [true, false]) {
      const { systemPrompt, userPrompt } = buildPrompts(makeCtx({ imageRequired }), null, "en");
      assert.ok(
        !/concise/i.test(imageSection(systemPrompt)),
        `"concise" survived in the section (imageRequired=${imageRequired})`
      );
      assert.ok(
        !/concise/i.test(jsonImageLine(userPrompt)),
        `"concise" survived in the JSON line (imageRequired=${imageRequired})`
      );
    }
  });

  it("orders the scene's sources: core message, then aspect, then the source's nouns", () => {
    const s = imageSection(buildPrompts(makeCtx({}), null, "en").systemPrompt);

    const core = s.indexOf('"coreMessage"');
    const aspect = s.indexOf("visual concept");
    const nouns = s.indexOf("Concrete nouns from the primary source");
    const sourceType = s.indexOf("What kind of source it is");
    const brand = s.indexOf("company description and target audience");

    for (const [name, idx] of [
      ["coreMessage", core],
      ["visual concept", aspect],
      ["concrete nouns", nouns],
      ["source type", sourceType],
      ["company description / audience", brand],
    ] as const) {
      assert.ok(idx >= 0, `the priority list must mention ${name}`);
    }
    // Priority is the point of the list — a shuffled order is a different
    // instruction, not a cosmetic edit.
    assert.ok(core < aspect, "coreMessage must outrank the visual concept");
    assert.ok(aspect < nouns, "the visual concept must outrank the source's nouns");
    assert.ok(nouns < sourceType, "the source's nouns must outrank the source type");
    assert.ok(sourceType < brand, "the source type must outrank the brand fields");
  });

  it("names every element the scene has to describe", () => {
    const s = imageSection(buildPrompts(makeCtx({}), null, "en").systemPrompt);

    for (const element of [
      "Main subject",
      "Specific action",
      "Environment / setting",
      "Relevant objects",
      "Composition and framing",
      "Lighting",
      "Mood / atmosphere",
      "Colour palette",
    ]) {
      assert.ok(s.includes(element), `the section must ask for: ${element}`);
    }
  });

  it("states the 80–180 word target in both the section and the JSON line", () => {
    const { systemPrompt, userPrompt } = buildPrompts(makeCtx({ imageRequired: true }), null, "en");

    assert.ok(imageSection(systemPrompt).includes("80–180"));
    assert.ok(jsonImageLine(userPrompt).includes("80–180"));
  });

  it("rules out the stock-photo defaults the field kept collapsing into", () => {
    const s = imageSection(buildPrompts(makeCtx({}), null, "en").systemPrompt);

    for (const cliche of [
      "a person using a laptop",
      "a person sitting at a desk",
      "a generic office",
      "a notebook and a computer",
      "people looking at screens",
    ]) {
      assert.ok(s.includes(cliche), `the section must name the cliché: ${cliche}`);
    }
    // Named as a prohibition, not left as an unqualified ban — sometimes the
    // source really is about people at desks.
    assert.ok(s.includes("unless that is genuinely what the source is about"));
  });

  it("carries a worked example long enough to show the target length", () => {
    const s = imageSection(buildPrompts(makeCtx({}), null, "en").systemPrompt);

    const good = s.split("\n").find((l) => l.startsWith("Good: "));
    assert.ok(good, "the section must carry a Good example");
    const words = good
      .replace(/^Good: /, "")
      .split(/\s+/)
      .filter(Boolean).length;
    assert.ok(words >= 80 && words <= 180, `the Good example is ${words} words, outside 80–180`);

    assert.ok(
      s.split("\n").some((l) => l.startsWith("Bad: ")),
      "the section must carry the Bad example too"
    );
  });

  it("leaves quality, anatomy and negative-prompt wording to the downstream builder", () => {
    const s = imageSection(buildPrompts(makeCtx({}), null, "en").systemPrompt);

    // The image prompt builder appends QUALITY_SUFFIX and assembles the negative
    // prompt itself. A model that writes its own only duplicates or contradicts
    // them, so none of that vocabulary may appear here.
    for (const term of [
      "photorealistic",
      "high-quality detail",
      "sharp focus",
      "anatomically coherent",
      "deformed",
      "blurry",
      "jpeg artifacts",
      "extra or missing fingers",
      "8k",
    ]) {
      assert.ok(
        !s.toLowerCase().includes(term),
        `downstream wording leaked into the section: ${term}`
      );
    }
    assert.ok(
      s.includes("appended automatically after you"),
      "the model must be told why it should not write its own"
    );
  });

  it("uses the brand colours in the palette line when the brand has them", () => {
    const ctx = {
      ...makeCtx({}),
      brand: makeBrand({ primaryColor: "#0F62FE", secondaryColor: "#FF6B00" }),
    };
    const s = imageSection(buildPrompts(ctx, null, "en").systemPrompt);

    assert.ok(
      s.includes("#0F62FE") && s.includes("#FF6B00"),
      "both brand colours must reach the section"
    );
    // A colour named without this instruction produces a swatch or a gradient,
    // not a photograph.
    assert.ok(s.includes("never as an overlay, swatch, or graphic element"));
  });

  it("uses one colour when only the primary is set", () => {
    const ctx = { ...makeCtx({}), brand: makeBrand({ primaryColor: "#0F62FE" }) };
    const s = imageSection(buildPrompts(ctx, null, "en").systemPrompt);

    assert.ok(s.includes("the brand colours are #0F62FE."));
  });

  it("falls back to a generic palette line when the brand names no colours", () => {
    for (const ctx of [makeCtx({}), { ...makeCtx({}), brand: makeBrand() }]) {
      const s = imageSection(buildPrompts(ctx, null, "en").systemPrompt);
      assert.ok(s.includes("Colour palette: the dominant tones of the scene"));
      assert.ok(!s.includes("the brand colours are"), "no brand colours to name");
    }
  });

  it("requires English no matter what language the post is written in", () => {
    for (const lang of ["en", "bg"]) {
      const s = imageSection(buildPrompts(makeCtx({}), null, lang).systemPrompt);
      assert.ok(
        s.includes("Write it in English, always, whatever language the post text is in."),
        `English rule missing for lang=${lang}`
      );
    }
  });

  it("forbids overlays, emojis, hashtags, UI instructions, brand names and invented facts", () => {
    const s = imageSection(buildPrompts(makeCtx({}), null, "en").systemPrompt);

    assert.ok(s.includes("No text overlays"));
    assert.ok(s.includes("No emojis, no hashtags, no UI or tooling instructions"));
    assert.ok(s.includes("Do not invent facts, places, people, or events it does not state."));
    // Competitor names are kept out of image generation on purpose — a brand
    // name in a visual prompt invites logo and house-style imitation.
    assert.ok(s.includes("Never name a company, brand, or competitor in the scene."));
  });

  it("points the JSON line at the section instead of restating a length rule", () => {
    for (const imageRequired of [true, false]) {
      const line = jsonImageLine(buildPrompts(makeCtx({ imageRequired }), null, "en").userPrompt);
      assert.ok(line.includes("Image Prompt section"), `JSON line must defer to the section`);
      assert.ok(line.includes("always in English regardless of post language"));
    }
  });
});

describe("prompt-builder — imagePrompt aspect anchoring", () => {
  const ASPECT = {
    id: "a1b2c3d4",
    title: "Hands-on prompt clinics",
    focus: "small-group prompt clinics run on the team's own live tickets",
    visualConcept: "a support team rewriting a real ticket queue together on a wall display",
  };

  function withAspect() {
    return buildPrompts(makeCtx({}), null, "en", [], { aspect: ASPECT }).userPrompt;
  }

  it("keeps the anchor line verbatim", () => {
    // Pre-existing behaviour: the mandatory anchor is unchanged, only what
    // follows it is new.
    assert.ok(
      withAspect().includes(`Your imagePrompt MUST visually anchor to: ${ASPECT.visualConcept}`)
    );
  });

  it("tells the model to expand the anchor into a full scene", () => {
    const userPrompt = withAspect();

    assert.ok(userPrompt.includes("That visual concept is the SUBJECT of the image"));
    assert.ok(
      userPrompt.includes("Expand it into the full scene the Image Prompt section describes"),
      "the anchor must hand off to the Image Prompt section"
    );
  });

  it("puts the expansion after the anchor it expands", () => {
    const userPrompt = withAspect();

    assert.ok(
      userPrompt.indexOf("MUST visually anchor to") <
        userPrompt.indexOf("That visual concept is the SUBJECT"),
      "the expansion must follow the anchor"
    );
  });

  it("adds no aspect image guidance when the generation has no aspect", () => {
    const userPrompt = buildPrompts(makeCtx({}), null, "en").userPrompt;

    assert.ok(!userPrompt.includes("MUST visually anchor to"));
    assert.ok(!userPrompt.includes("That visual concept is the SUBJECT"));
  });
});

describe("prompt-builder — visual diversity", () => {
  /** The `## Image Prompt` block on its own, up to the next `## ` heading. */
  function imageSection(systemPrompt: string): string {
    const start = systemPrompt.indexOf("## Image Prompt");
    assert.ok(start >= 0, "system prompt must carry the Image Prompt section");
    const rest = systemPrompt.slice(start + 1);
    const end = rest.indexOf("\n## ");
    return end === -1 ? rest : rest.slice(0, end);
  }

  const RECENT = [
    {
      text: "Our onboarding flow got 40% shorter this quarter.",
      imagePrompt:
        "A product designer stands at a glass wall covered in sticky notes, moving one card down a column while two colleagues watch from a low sofa. Afternoon light from a tall window, medium-wide shot.",
    },
    {
      text: "Why we stopped running quarterly training days.",
      imagePrompt:
        "A trainer leans over a workshop table, sketching a flow on butcher paper while four participants follow along. Overhead pendant lights, warm tones, three-quarter shot from standing height.",
    },
    {
      text: "The support queue told us what the roadmap could not.",
      imagePrompt:
        "A support lead reads a printed ticket beside a wall display of open cases, marker in hand. Cool screen glow against late daylight, medium shot.",
    },
  ];

  const VISUAL_BLOCK_HEADING = "**Recent image prompts — do not repeat these visuals**";

  function withRecent(recent = RECENT) {
    return buildPrompts(makeCtx({ imageRequired: true }), null, "en", recent).userPrompt;
  }

  it("lists the recent image prompts as visuals to move away from", () => {
    const userPrompt = withRecent();

    assert.ok(userPrompt.includes(VISUAL_BLOCK_HEADING));
    for (const r of RECENT) {
      assert.ok(
        userPrompt.includes(r.imagePrompt.slice(0, 60)),
        `the recent visual must reach the prompt: ${r.imagePrompt.slice(0, 40)}…`
      );
    }
  });

  it("names every visual axis the new scene has to differ on", () => {
    const userPrompt = withRecent();

    for (const axis of [
      "environment and room type",
      "subject type",
      "main action",
      "composition",
      "camera distance",
      "lighting setup",
      "dominant objects",
      "visual metaphor",
    ]) {
      assert.ok(userPrompt.includes(axis), `the visual block must name the axis: ${axis}`);
    }
  });

  it("reuses the recentPosts argument rather than adding a second source of context", () => {
    // The visuals ride on the same array that already carried the post text: one
    // argument, one query, no new store and no extra LLM call. Both blocks must
    // come out of that single call.
    const userPrompt = withRecent();

    assert.ok(
      userPrompt.includes("Previously generated posts for this channel"),
      "the existing recent-text block must still be built from the same argument"
    );
    assert.ok(userPrompt.includes(VISUAL_BLOCK_HEADING));
    assert.ok(userPrompt.includes(RECENT[0].text), "the post text still reaches the prompt");
    assert.ok(userPrompt.includes(RECENT[0].imagePrompt.slice(0, 60)));
  });

  it("omits the visual block when the recent posts carry no image prompts", () => {
    // Legacy posts, and posts on channels that never generated an image, have no
    // imagePrompt. An empty "avoid these visuals" heading would be pure noise.
    const userPrompt = buildPrompts(makeCtx({}), null, "en", [
      { text: "A post from before imagePrompt was stored." },
      { text: "Another one.", imagePrompt: null },
      { text: "And a blank one.", imagePrompt: "   " },
    ]).userPrompt;

    assert.ok(!userPrompt.includes(VISUAL_BLOCK_HEADING));
    assert.ok(
      userPrompt.includes("A post from before imagePrompt was stored."),
      "the text block is unaffected"
    );
  });

  it("distinguishes visual repetition from text and topic repetition", () => {
    // The failure this guards against is two posts about different things that
    // produce the same picture — passing the text/topic rules proves nothing.
    const userPrompt = withRecent();
    const s = imageSection(buildPrompts(makeCtx({}), null, "en").systemPrompt);

    assert.ok(
      s.includes(
        "This is a separate requirement from the post text and topic repetition rules: two posts on different topics still fail if they produce the same picture."
      ),
      "the system section must separate the visual rule from the text rule"
    );
    assert.ok(
      userPrompt.includes(
        "This is about the picture, not the post text — writing a different post is a separate requirement and does not satisfy this one."
      ),
      "the user block must say the same"
    );
  });

  it("does not ask for a random or unrelated scene", () => {
    const userPrompt = withRecent();
    const s = imageSection(buildPrompts(makeCtx({}), null, "en").systemPrompt);

    assert.ok(
      s.includes("The variety must come from the source, never from randomness."),
      "variety must be sourced, not rolled"
    );
    assert.ok(
      s.includes("an unrelated or arbitrary scene is a worse failure than a repeated one"),
      "the model must know which way the trade-off runs"
    );
    assert.ok(
      s.includes(
        "Where several faithful scenes are possible, choose the one that differs most from the recent visuals."
      ),
      "diversity is a tie-break between faithful options, not an override of faithfulness"
    );
    assert.ok(
      userPrompt.includes(
        "Stay faithful to the current source: choose a different accurate scene, not an unrelated or random one."
      )
    );
  });

  it("keeps the imagePrompt grounded in the current source while avoiding the recent ones", () => {
    // The anti-repetition block must not displace the grounding instruction: the
    // build order (coreMessage → aspect → source nouns) has to survive alongside it.
    const { systemPrompt, userPrompt } = buildPrompts(
      makeCtx({ imageRequired: true }),
      null,
      "en",
      RECENT
    );
    const s = imageSection(systemPrompt);

    assert.ok(s.includes('Your own "coreMessage"'));
    assert.ok(s.includes("Concrete nouns from the primary source"));
    assert.ok(
      s.indexOf('Your own "coreMessage"') < s.indexOf("**Be different from the recent images.**"),
      "grounding is stated before the diversity rule that qualifies it"
    );
    assert.ok(userPrompt.includes(VISUAL_BLOCK_HEADING));
  });

  it("discourages the default motifs unless the source requires them", () => {
    const s = imageSection(buildPrompts(makeCtx({}), null, "en").systemPrompt);

    for (const motif of [
      "a laptop on a desk",
      "a person at a workstation",
      "a warm modern office",
      "plants beside a window",
      "a person centred behind a table",
      "a glowing screen as the focal point",
    ]) {
      assert.ok(s.includes(motif), `the section must name the default motif: ${motif}`);
    }
    assert.ok(s.includes("unless the source genuinely requires it"));
  });

  it("caps how much recent visual context it spends", () => {
    // Each imagePrompt is now 80–180 words; listing five in full would outweigh
    // the source article. Three openings are enough to expose a motif.
    const many = Array.from({ length: 5 }, (_, i) => ({
      text: `post ${i}`,
      imagePrompt: `${"x".repeat(400)} tail-marker-${i}`,
    }));
    const userPrompt = buildPrompts(makeCtx({}), null, "en", many).userPrompt;

    const listed = userPrompt.split("\n").filter((l) => l.startsWith("- x"));
    assert.equal(listed.length, 3, "at most three recent visuals are listed");
    assert.ok(
      listed.every((l) => l.length < 320),
      "each listed visual is truncated"
    );
    assert.ok(!userPrompt.includes("tail-marker-0"), "the long tail is cut, not carried");
  });

  it("carries the visual block into the retry prompt", () => {
    // The retry wraps the base user prompt, so a regeneration triggered by a text
    // duplicate must still be told which pictures to avoid.
    const retry = buildRetryUserPrompt(withRecent(), {
      candidateText: "rejected",
      matchedText: "",
      similarityScore: 0,
    });

    assert.ok(retry.includes(VISUAL_BLOCK_HEADING));
  });
});

describe("prompt-builder — imageRequired", () => {
  it("marks imagePrompt as REQUIRED in the JSON format when imageRequired=true", () => {
    const { userPrompt } = buildPrompts(makeCtx({ imageRequired: true }), null);
    // Extract the imagePrompt line from the JSON format block
    const imagePromptLine = userPrompt.split("\n").find((l) => l.includes('"imagePrompt"'));
    assert.ok(imagePromptLine, "JSON format block must include an imagePrompt line");
    assert.ok(
      imagePromptLine.includes("REQUIRED"),
      "imagePrompt line should say REQUIRED when imageRequired=true"
    );
    assert.ok(
      !imagePromptLine.toLowerCase().includes("optional"),
      "imagePrompt line must not say optional when imageRequired=true"
    );
  });

  it("marks imagePrompt as optional in the JSON format when imageRequired=false", () => {
    const { userPrompt } = buildPrompts(makeCtx({ imageRequired: false }), null);
    const imagePromptLine = userPrompt.split("\n").find((l) => l.includes('"imagePrompt"'));
    assert.ok(imagePromptLine, "JSON format block must include an imagePrompt line");
    assert.ok(
      imagePromptLine.toLowerCase().includes("optional"),
      "imagePrompt line should say optional when imageRequired=false"
    );
    assert.ok(
      !imagePromptLine.includes("REQUIRED"),
      "imagePrompt line must not say REQUIRED when imageRequired=false"
    );
  });
});
