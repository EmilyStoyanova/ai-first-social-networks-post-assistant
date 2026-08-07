import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPrompts } from "./prompt-builder";
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

  it("keeps competitors out of the user prompt, which carries the imagePrompt rules", () => {
    const ctx = ctxWithCompetitors(["Globex"]);
    const { userPrompt } = buildPrompts(ctx, null);

    // Image generation must never receive competitor names — a brand name in a
    // visual prompt invites logo and style imitation. The image prompt is built
    // from the model's imagePrompt field, whose instructions live here.
    assert.ok(
      !userPrompt.includes("Globex"),
      "competitor names must not reach the image-facing half of the prompt"
    );
    assert.ok(!userPrompt.includes("Competitor Positioning"));
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
