import type { BrandContext, FeedItemContext, GenerationContext } from "./types";
import { type ContentAngle, ANGLE_INSTRUCTIONS } from "./content-angle";
import {
  type PostPattern,
  HOOK_INSTRUCTIONS,
  STRUCTURE_INSTRUCTIONS,
  CTA_INSTRUCTIONS,
} from "./post-pattern";
import type { ContentAspect } from "./content-aspect";
import { getChannelPolicy } from "./channel-policy";
import {
  extractionFoundNothing,
  framePrimarySource,
  renderFeedItemContent,
  sourceExtractionInstruction,
} from "./source-content";
import type { ComplianceFailure } from "./quality/generation-compliance";

export interface BuiltPrompts {
  systemPrompt: string;
  userPrompt: string;
}

export interface RecentPostContext {
  text: string;
  /**
   * The imagePrompt this post was generated with, when it has one.
   *
   * Already persisted on Post — no new store, no extra query, no second LLM
   * call. It is the only record of what the recent IMAGES looked like: the text
   * of a post says nothing about the room, the framing, or the light, so
   * de-duplicating post text cannot stop two posts converging on one picture.
   */
  imagePrompt?: string | null;
}

/**
 * The topic a SIBLING channel version must adapt rather than replace.
 *
 * Multi-channel generation decides a topic once and writes it for each selected
 * channel. Without this the three generations would each pick their own subject
 * from the same article and the "group" would be three unrelated posts sharing a
 * headline — which is what a reader would notice first.
 */
export interface SharedTopicConstraint {
  /** The central claim the first channel settled on. Reproduced, not restated. */
  coreMessage: string;
  /** Its normalized topic, when the first generation declared one. */
  topic: string | null;
  /** The channel that established it, named so the instruction reads concretely. */
  establishedBy: string;
}

export interface PromptDiversityHints {
  angle?: ContentAngle;
  pattern?: PostPattern;
  /** Topics declared by recent posts — model is instructed to avoid these. */
  recentTopics?: readonly string[];
  /** Dynamically mined content aspect — mandatory conceptual constraint for the post. */
  aspect?: ContentAspect;
  /**
   * Set only for the second and later channels of one content group. Mutually
   * exclusive with `recentTopics` in effect: see the suppression in
   * buildUserPrompt, since "cover a different subject" and "cover exactly this
   * subject" cannot both be true.
   */
  sharedTopic?: SharedTopicConstraint;
}

// ─── Channel metadata ─────────────────────────────────────────────────────────

const CHANNEL_LABELS: Record<string, string> = {
  facebook: "Facebook",
  linkedin: "LinkedIn",
  instagram: "Instagram",
  tiktok: "TikTok",
};

/**
 * Channel guidance comes from CHANNEL_POLICIES (v2-3) — this file holds no
 * platform claims of its own. Only WARNING/SUGGESTION hints reach the prompt;
 * BLOCKING constraints are enforced at publish time and contribute no text
 * (a constraint blocks, it does not advise).
 *
 * Fragments are joined in hint order with no added decoration, which keeps the
 * rendered block byte-identical to the pre-v2-3 CHANNEL_RULES text — the
 * refactor changes where the guidance lives, never what the model receives.
 */
function buildChannelHintBlock(channel: string): string {
  const policy = getChannelPolicy(channel);
  if (!policy) return "";
  return policy.hints.map((h) => h.promptFragment).join("\n");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function section(title: string, content: string): string {
  return `## ${title}\n${content.trim()}`;
}

function optional(label: string, value: string | null | undefined): string {
  return value ? `${label}: ${value}` : "";
}

function lines(...parts: string[]): string {
  return parts.filter(Boolean).join("\n");
}

/**
 * How to fix each enforced compliance failure.
 *
 * Keyed by the dimensions that can actually fail — which is only `bannedWords`.
 * The angle/hook/structure/CTA remediations that used to live here were
 * unreachable once those dimensions stopped being gated (see
 * quality/generation-compliance.ts): they are generation guidance now, and a
 * post is never sent back to the model to fix one.
 */
const REMEDIATION_GUIDANCE: Record<ComplianceFailure["dimension"], string> = {
  bannedWords:
    "Remove the banned word entirely and rewrite the section so the meaning is preserved without it.",
};

function getRemediationGuidance(failure: ComplianceFailure): string {
  return REMEDIATION_GUIDANCE[failure.dimension];
}

// ─── Image prompt instruction ─────────────────────────────────────────────────

/**
 * The example of a scene built the way this section asks for one. Long enough to
 * demonstrate the target length rather than merely assert it, and drawn from a
 * deliberately unrelated domain so it reads as a shape to copy, not a subject.
 */
const IMAGE_PROMPT_GOOD_EXAMPLE =
  "A warehouse supervisor in a navy polo shirt scans a pallet label with a handheld " +
  "barcode reader, the other hand steadying a stack of shrink-wrapped cartons. Behind " +
  "them steel racking runs five levels high into the depth of the frame, half-loaded " +
  "with blue and grey crates; a forklift waits out of focus at the far end of the aisle. " +
  "Medium shot from slightly below, the supervisor placed off-centre to the left so the " +
  "racking leads the eye back into the space. Cool overhead fluorescent light mixed with " +
  "daylight spilling in from a loading door on the right. Calm, orderly, mid-shift " +
  "atmosphere — competent work already in progress, not a posed portrait.";

/** The stock-photo fallbacks the field kept collapsing into. */
const IMAGE_PROMPT_CLICHES = [
  "a person using a laptop",
  "a person sitting at a desk",
  "a generic office",
  "a notebook and a computer",
  "people looking at screens",
] as const;

/**
 * The axes along which two image prompts have to differ before the pictures do.
 *
 * Shared verbatim by the system-prompt rule and the user-prompt block that lists
 * the recent visuals, so the standard the model is held to is stated once.
 */
const VISUAL_VARIETY_AXES =
  "environment and room type, subject type, main action, composition, camera distance, " +
  "lighting setup, dominant objects, and visual metaphor";

/**
 * The motifs the model drifts back to once the topic stops pulling hard — the
 * ones the previous richer instruction did not, on its own, prevent.
 */
const IMAGE_PROMPT_DEFAULT_MOTIFS = [
  "a laptop on a desk",
  "a person at a workstation",
  "a warm modern office",
  "plants beside a window",
  "a person centred behind a table",
  "a glowing screen as the focal point",
] as const;

/**
 * What the model must put in the "imagePrompt" field.
 *
 * The field used to be specified by a single clause inside the JSON block —
 * "concise English visual description" — and that adjective was doing real
 * damage: the model answered it literally, with one generic stock-photo sentence
 * ("A person with a notebook and laptop working on AI concepts in a quiet
 * room."), and near-identical images came out post after post.
 *
 * Nothing here adds context. Everything the scene needs is already in the
 * prompt: the model's own coreMessage, the mined content aspect, the concrete
 * nouns of the primary source, and the brand. What was missing was the
 * instruction to USE it, and the order to use it in.
 *
 * Deliberately carries no quality, resolution, or anatomy wording, and none of
 * the "avoid deformed/blurry/…" exclusions: buildImagePrompt() appends the
 * quality suffix and assembles the negative prompt downstream, and a model that
 * writes its own would only duplicate or contradict them.
 */
function buildImagePromptSection(brand: BrandContext | null): string {
  const brandColors = [brand?.primaryColor, brand?.secondaryColor].filter((c): c is string =>
    Boolean(c)
  );

  // Brand colours are useful to an image model only as the colour of something
  // real in the frame. Named without that instruction they invite a swatch, a
  // gradient background, or a branded graphic — none of which is a photograph.
  const paletteLine =
    brandColors.length > 0
      ? `- Colour palette: the brand colours are ${brandColors.join(" and ")}. Let them lead the scene's dominant tones where the subject genuinely allows it, as the colour of real things in the shot — clothing, packaging, walls, machinery, sky — never as an overlay, swatch, or graphic element.`
      : "- Colour palette: the dominant tones of the scene, and how they carry its mood.";

  // Joined directly rather than through lines(): the blank separators are load
  // bearing for a block this long, and lines() filters empty strings out.
  return section(
    "Image Prompt",
    [
      'The "imagePrompt" field is the complete prompt handed to an image generation model. It is a description of a single photographable scene — not a caption, not a restatement of the post, and not a topic label.',
      "",
      "**Build the scene from what you already know, in this order:**",
      '1. Your own "coreMessage" and the meaning of the post you just wrote. The image must show the situation your central claim describes — someone reading the post and seeing the image should recognise them as the same idea.',
      "2. The content aspect's visual concept and focus, when this generation was given one. It is mandatory, not a suggestion: the scene must be recognisably that concept, expanded into a full setting rather than quoted as a phrase.",
      "3. Concrete nouns from the primary source: the actual objects, places, professions, activities, products, or events it names. Use its specifics, not the category they belong to.",
      "4. What kind of source it is. An event is people gathered in a real venue; a product page is the product itself, in use; a brief is the subject the brief names.",
      "5. The company description and target audience above, when they make the setting or the people in it more specific. Skip them when they would only add vagueness.",
      "",
      "**Describe all of the following, as flowing English prose — not a bulleted list and not `key: value` pairs:**",
      "- Main subject: who or what the image is of.",
      "- Specific action: what that subject is actually doing, at this moment. Not a state, not a pose.",
      "- Environment / setting: the real place it happens in.",
      "- Relevant objects: the things that belong in that place and in that action.",
      "- Composition and framing: shot distance, camera angle, where the subject sits in the frame, what is in the foreground and background.",
      "- Lighting: source, direction, quality, time of day.",
      "- Mood / atmosphere.",
      paletteLine,
      "",
      "**Length: roughly 80–180 English words.** One sentence is not an image prompt.",
      "",
      "**Be concrete.** A generic stock-photo concept is a failure even when it is technically related to the topic — it produces the same picture for every post. Do not fall back on " +
        IMAGE_PROMPT_CLICHES.map((c) => `"${c}"`).join(", ") +
        ", or any equivalent, unless that is genuinely what the source is about.",
      "",
      // Being concrete is not the same as being different: a faithful, specific
      // scene can still be the eighth faithful, specific scene set in the same
      // room. This rule is about the picture only — the post text and topic have
      // their own repetition rules elsewhere, and passing those proves nothing here.
      "**Be different from the recent images.** This is a separate requirement from the post text and topic repetition rules: two posts on different topics still fail if they produce the same picture. When recent image prompts are listed in the user message, treat them as visuals to move away from, and vary the " +
        VISUAL_VARIETY_AXES +
        ".",
      "- Do not reach for " +
        IMAGE_PROMPT_DEFAULT_MOTIFS.map((m) => `"${m}"`).join(", ") +
        " unless the source genuinely requires it.",
      "- The variety must come from the source, never from randomness. The scene must still depict this post's coreMessage and source faithfully — an unrelated or arbitrary scene is a worse failure than a repeated one. Where several faithful scenes are possible, choose the one that differs most from the recent visuals.",
      "",
      'Bad: "A person with a notebook and laptop working on AI concepts in a quiet room." (one line, no specific action, no real place, and it would illustrate any post ever written)',
      `Good: "${IMAGE_PROMPT_GOOD_EXAMPLE}"`,
      "",
      "**Rules:**",
      "- Write it in English, always, whatever language the post text is in.",
      "- Describe only what the source supports. Do not invent facts, places, people, or events it does not state.",
      "- No text overlays, lettering, captions, signage, logos, or watermarks anywhere in the scene.",
      "- No emojis, no hashtags, no UI or tooling instructions, no camera brand or model names.",
      // The section sits in the same message as Competitor Positioning, and a
      // brand name in a visual prompt is an invitation to imitate its logo and
      // house style — the reason competitors are kept out of image generation.
      "- Never name a company, brand, or competitor in the scene. Describe what a thing looks like, not whose it is.",
      "- Do not add image-quality, resolution, or anatomy wording, and do not list things to avoid. Those are appended automatically after you — writing your own only contradicts them.",
    ].join("\n")
  );
}

// ─── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(ctx: GenerationContext, contentLanguage?: string): string {
  const { company, brand, channel } = ctx;
  const channelLabel = CHANNEL_LABELS[channel.channel] ?? channel.channel;
  const lang = (contentLanguage ?? channel.postingLanguage).toUpperCase();
  const automationMode = channel.automationModeOverride ?? company.automationMode;

  const companySection = section(
    "Company",
    lines(
      `Name: ${company.name}`,
      optional("Website", company.website),
      optional("Description", brand?.companyDescription)
    )
  );

  const brandSection = brand
    ? section(
        "Brand Voice",
        lines(
          optional("Tone of voice", brand.toneOfVoice),
          optional("Target audience", brand.targetAudience),
          brand.forbiddenWords.length > 0
            ? `Forbidden words: ${brand.forbiddenWords.join(", ")}`
            : "",
          brand.primaryColor ? `Primary brand color: ${brand.primaryColor}` : "",
          brand.secondaryColor ? `Secondary brand color: ${brand.secondaryColor}` : ""
        )
      )
    : "";

  // Its own section rather than a line inside Brand Voice: the competitor names
  // are useless without the rule that governs them, and a bare "Competitors: X,
  // Y" line reads to a model as permission to compare. Omitted entirely when the
  // company listed none — an empty heading would be noise in every prompt.
  const competitorSection =
    brand && brand.competitors.length > 0
      ? section(
          "Competitor Positioning",
          lines(
            "Use the listed competitors only as positioning context. Create distinct content that reflects the company’s own brand, strengths, and tone. Do not imitate competitors, make unsupported comparisons, or mention them unless the source content explicitly requires it.",
            "Competitors:",
            brand.competitors.map((c) => `- ${c}`).join("\n")
          )
        )
      : "";

  const channelSection = section(
    `Channel: ${channelLabel}`,
    lines(
      buildChannelHintBlock(channel.channel),
      `Image required: ${channel.imageRequired ? "Yes — describe visual context." : "No."}`,
      `Post language: ${lang}`
    )
  );

  const automationSection = section(
    "Automation Mode",
    automationMode === "fully_automated"
      ? "Fully automated — this post will be published without human review. Be conservative and brand-safe."
      : "Semi-automated — a human editor will review before publishing. You may be slightly more creative."
  );

  const languageInstruction =
    lang === "BG" ? "Generate the post in Bulgarian." : "Generate the post in English.";

  const writingRules = section(
    "Writing Rules",
    lines(
      `- ${languageInstruction}`,
      `- Write the post text (the "text" field) entirely in ${lang}.`,
      `- imagePrompt MUST always be written in English, regardless of the post language. Image generation models do not support ${lang === "BG" ? "Bulgarian" : lang} text.`,
      "- Stay within the brand voice described above.",
      "- Never include URLs unless specifically requested.",
      brand?.forbiddenWords.length
        ? `- Never use these words: ${brand.forbiddenWords.join(", ")}.`
        : "",
      '- Never use the word "Стоп" anywhere in the post, in any casing or with any punctuation (e.g. "Стоп", "СТОП", "Стоп!", "Стоп на…", "Кажи стоп на…") — and especially never as the opening hook.',
      "- Do not fabricate facts. Use only what the provided content supports.",
      "- Return ONLY a JSON object — no markdown fences, no explanation, no extra text."
    )
  );

  const coreMessageSection = section(
    "Core Message — Mandatory",
    lines(
      'Every post must be built around a single core message. The "coreMessage" field of the JSON response must contain it.',
      "- It must be exactly one sentence.",
      "- It must state ONE specific, testable central claim — a point that could be verified against the source content, not a mood or an impression.",
      "- It must stand on its own, independent of the hook, opening line, or call to action.",
      "- It is NOT a summary of the source article, and NOT the topic label. Do not merely name the subject or restate the article title.",
      '- Avoid generic destination or product praise. Do NOT use phrases such as "ideal place", "perfect choice", "unforgettable experience", "something for everyone", "a must-visit", or "the best" UNLESS the source supports a specific, concrete reason that you state in the same sentence.',
      "- Anchor the claim to a concrete differentiator from the source: a specific fact, feature, number, problem solved, audience need, or takeaway. If the post has a content aspect, the coreMessage must express that aspect's concrete differentiator.",
      `- Write it in the same language as the post text (${lang}).`,
      'Example — topic: "family holidays in Corfu"',
      'Bad: "Corfu is ideal for family holidays." (generic praise — no specific, testable reason)',
      'Bad: "Family holidays in Corfu." (that is the topic, not a claim)',
      'Good: "Corfu\'s shallow, calm north-east bays let toddlers wade safely, which is why families with young children favour it."',
      'Example — topic: "marketing automation"',
      'Bad: "Marketing automation." (that is the topic, not a claim)',
      'Bad: "This post talks about marketing automation." (a meta description, not a claim)',
      'Good: "Automating repetitive marketing work gives small businesses more time for strategic growth."'
    )
  );

  const imagePromptSection = buildImagePromptSection(brand);

  const bulgarianQualitySection =
    lang === "BG"
      ? section(
          "Bulgarian Language Quality — Mandatory",
          lines(
            "You are writing for a Bulgarian audience. Apply every rule below without exception.",
            "- Write as a professional Bulgarian copywriter. Do NOT translate from English — think and write directly in Bulgarian.",
            "- Use vocabulary and phrasing that a Bulgarian marketing professional would naturally choose. Do not reach for the nearest Bulgarian equivalent of an English word; choose the word Bulgarians actually use in this context and register.",
            "- Prefer short, direct sentences. Avoid long compound clauses that arise from translating English subordinate constructions.",
            "- Never produce phrases that are grammatically correct but sound foreign or unnatural to a native speaker. If a phrase reads like a translation, rephrase it from scratch.",
            "- Examples of the kind of unnatural phrasing to avoid: 'проверената дължина', 'при въжето' — grammatically possible but not how a Bulgarian professional would naturally write. Apply the same judgment to any similar construction, regardless of the topic.",
            "- Do not change the meaning, selected theme, structure, hashtags, image concept, or call to action. Improve only: word choice, idiomatic phrasing, sentence fluency, and grammar.",
            "- The final text must be publishable by a Bulgarian company's marketing team without any editing."
          )
        )
      : "";

  const parts = [
    `You are a professional social media content creator for ${company.name}.`,
    companySection,
    brandSection,
    competitorSection,
    channelSection,
    automationSection,
    writingRules,
    coreMessageSection,
    imagePromptSection,
    bulgarianQualitySection,
  ].filter(Boolean);

  return parts.join("\n\n");
}

// ─── User prompt ──────────────────────────────────────────────────────────────

const TOTAL_FEED_CHAR_LIMIT = 5000;

/**
 * How many recent image prompts to show, and how much of each.
 *
 * An imagePrompt is now 80–180 words, so listing five in full would add more
 * text than the source article itself. Three openings are enough to expose a
 * motif: subject, action, and setting — the parts that actually repeat — are
 * stated first, and the tail (framing, light, mood) varies more freely anyway.
 */
const RECENT_VISUAL_LIMIT = 3;
const RECENT_VISUAL_CHAR_LIMIT = 300;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`;
}

/**
 * Renders a feed item as a `**title**` + body block (empty when it has neither).
 *
 * Shaped by the item's source type — see source-content.ts. Plain-text sources
 * are unchanged; the JSON-backed ones (product page, calendar event) are turned
 * into readable fields instead of being dumped as a raw object.
 */
function excerptFor(item: FeedItemContext): string {
  return renderFeedItemContent(item);
}

function buildJsonFormatInstruction(imageRequired: boolean): string {
  // The word "concise" used to sit in both branches and was answered literally:
  // a single generic sentence, and the same image every time. The field's real
  // specification now lives in the Image Prompt section of the system prompt;
  // these lines point at it instead of restating a length.
  const imagePromptLine = imageRequired
    ? `  "imagePrompt": "REQUIRED — a detailed English visual scene of roughly 80–180 words, built as the Image Prompt section instructs (no text overlays, no emojis, no hashtags, no UI instructions; always in English regardless of post language)"`
    : `  "imagePrompt": "optional — if provided, a detailed English visual scene of roughly 80–180 words, built as the Image Prompt section instructs (no text overlays, no emojis, no hashtags, no UI instructions; always in English regardless of post language)"`;

  return `Return ONLY a JSON object in this exact format (no markdown, no explanation):
{
  "text": "the post text",
  "hashtags": ["tag1", "tag2"],
  "coreMessage": "one sentence stating the single central claim/takeaway of this post — not the topic, not a summary; in the same language as the post text",
${imagePromptLine},
  "notes": "brief creative rationale (optional)",
  "topic": "2–5 words describing the specific subject of this post (e.g. 'hiring for culture fit', 'startup cash flow')"
}`;
}

function buildUserPrompt(
  ctx: GenerationContext,
  primary: FeedItemContext | null,
  contentLanguage?: string,
  recentPosts: RecentPostContext[] = [],
  diversity?: PromptDiversityHints
): string {
  const { channel, feedItems } = ctx;
  const channelLabel = CHANNEL_LABELS[channel.channel] ?? channel.channel;
  const lang = (contentLanguage ?? channel.postingLanguage).toUpperCase();
  const imageRequired = channel.imageRequired;

  // The primary is passed in, already resolved (see PrimarySelection): the same
  // item whose URL the service appends and whose id the post records. Every
  // other feed item is background only. Deriving it here from feedItems[0] would
  // reintroduce the possibility of the prompt and the URL disagreeing.

  let feedSection = "";
  if (primary) {
    // Primary always fits: it is allotted the budget first.
    let budget = TOTAL_FEED_CHAR_LIMIT;
    const primaryBlock = excerptFor(primary);
    budget -= primaryBlock.length + 10;

    const secondaryBlocks: string[] = [];
    for (const item of feedItems) {
      if (item.id === primary.id) continue;
      if (budget <= 0) break;
      const block = excerptFor(item);
      if (!block) continue;
      const cost = block.length + 10; // +10 for separator overhead
      if (cost > budget) break;
      budget -= cost;
      secondaryBlocks.push(block);
    }

    // An article, an event, and a brief are three different things, and the
    // heading is the model's only cue which one it is holding.
    const framing = framePrimarySource(primary);

    const primarySection = [
      framing.heading,
      framing.instruction,
      "---",
      primaryBlock || "(no excerpt available for the primary source)",
      "---",
    ].join("\n");

    const secondarySection =
      secondaryBlocks.length > 0
        ? [
            "**Additional background context — for topical awareness only.**",
            "Do NOT write the post about any of these. They are not the subject and their links will not be used.",
            "---",
            secondaryBlocks.join("\n---\n"),
            "---",
          ].join("\n")
        : "";

    feedSection = [primarySection, secondarySection].filter(Boolean).join("\n\n");
  }

  const recentSection =
    recentPosts.length > 0
      ? [
          "Previously generated posts for this channel. Do not repeat or paraphrase them. Write a meaningfully different post with a different angle, hook, or tone.",
          "---",
          ...recentPosts.map((p) => p.text),
          "---",
        ].join("\n")
      : "";

  // The visuals of the recent posts, from the imagePrompt already stored on each
  // one. Rendered separately from recentSection on purpose: that block asks for a
  // different post, and a model that obliges can still ask for the same picture.
  const recentVisuals = recentPosts
    .map((p) => p.imagePrompt?.trim())
    .filter((v): v is string => Boolean(v))
    .slice(0, RECENT_VISUAL_LIMIT);

  const recentVisualSection =
    recentVisuals.length > 0
      ? [
          "**Recent image prompts — do not repeat these visuals**",
          `These are the images already generated for this channel. Your imagePrompt must differ from every one of them in ${VISUAL_VARIETY_AXES}. This is about the picture, not the post text — writing a different post is a separate requirement and does not satisfy this one.`,
          "Stay faithful to the current source: choose a different accurate scene, not an unrelated or random one.",
          "---",
          ...recentVisuals.map((v) => `- ${truncate(v, RECENT_VISUAL_CHAR_LIMIT)}`),
          "---",
        ].join("\n")
      : "";

  // Keyed off the primary, not the array: with no primary there is no feed
  // section, so asking for a post "about" nothing would leave the model to
  // invent a subject.
  const intro = !primary
    ? `Create an original ${channelLabel} post for ${ctx.company.name}.\nWrite in ${lang}.`
    : `Write a ${channelLabel} post for ${ctx.company.name}.`;

  const { angle, pattern, recentTopics, aspect, sharedTopic } = diversity ?? {};

  const angleSection = angle ? `**Content angle: ${angle}**\n${ANGLE_INSTRUCTIONS[angle]}` : "";

  const patternSection = pattern
    ? [
        `**Hook: ${pattern.hookType}**\n${HOOK_INSTRUCTIONS[pattern.hookType]}`,
        `**Structure: ${pattern.structure}**\n${STRUCTURE_INSTRUCTIONS[pattern.structure]}`,
        `**CTA: ${pattern.ctaType}**\n${CTA_INSTRUCTIONS[pattern.ctaType]}`,
      ].join("\n\n")
    : "";

  // Suppressed outright when this generation is a sibling channel version: the
  // topic is already decided, so listing subjects to avoid would contradict the
  // shared-topic section below — and a prompt that contradicts itself is
  // resolved by the model, not by us.
  const topicSection =
    !sharedTopic && recentTopics && recentTopics.length > 0
      ? [
          "**Topic guidance**",
          "The following subjects have been covered recently — choose a meaningfully different one:",
          recentTopics.map((t) => `- ${t}`).join("\n"),
        ].join("\n")
      : "";

  const sharedTopicSection = sharedTopic
    ? [
        "**Shared content topic — mandatory constraint**",
        `This post is the ${channelLabel} version of a topic already written for ${sharedTopic.establishedBy}. It is the same story told for a different audience.`,
        `The central claim MUST be this one: ${sharedTopic.coreMessage}`,
        ...(sharedTopic.topic ? [`Subject: ${sharedTopic.topic}`] : []),
        "Your coreMessage MUST express that same claim. Do NOT choose a different angle, a different takeaway, or a different part of the source content.",
        `What changes is HOW it is told: rewrite it from scratch in ${channelLabel}'s register, length, structure and hook, following this post's own channel guidance above. Do not translate, paraphrase, or lightly edit the other channel's wording — a reader who follows both accounts must not see the same sentences twice.`,
      ].join("\n")
    : "";

  const aspectSection = aspect
    ? [
        "**Content aspect — mandatory conceptual constraint**",
        `Focus: ${aspect.focus}`,
        "You MUST build this post around this specific focus. Do NOT replace it with a more prominent theme from the source content. The focus is the conceptual core of this post, not a suggestion.",
        "Your coreMessage MUST express the concrete differentiator of this focus as one specific, testable claim — not broad praise about the overall subject.",
        `Your imagePrompt MUST visually anchor to: ${aspect.visualConcept}`,
        // The anchor line alone was read as something to paste in and stop. It
        // stays verbatim — the Image Prompt section is what it now hands off to.
        "That visual concept is the SUBJECT of the image, not a phrase to append to it. Expand it into the full scene the Image Prompt section describes: subject, specific action, setting, objects, framing, lighting, and mood.",
      ].join("\n")
    : "";

  // What the SOURCE itself says this post must contain, when its owner said
  // anything. Nothing else in this prompt is a direct instruction from a person
  // about this specific page, which is why it is stated as outranking the
  // heuristics — and why aspect mining stands down entirely when it is present
  // (see resolveGenerationAspect): "build the post around this one focus" and
  // "cover every item on the page" cannot both be obeyed, and the mined focus
  // was silently winning.
  // Suppressed when the extraction ran and found nothing: the source block above
  // already says there is nothing to write about, and "cover every item" beside
  // it would be a contradiction for the model to resolve.
  const extractionInstruction = extractionFoundNothing(primary)
    ? null
    : sourceExtractionInstruction(primary);
  const extractionSection = extractionInstruction
    ? [
        "**Required content — the source's own extraction instruction. This outranks every guidance section above.**",
        extractionInstruction,
        "Cover EVERY item the source block above provides, with every detail it gives for each one. Do not present one item as an example and summarise the rest away, and do not replace the list with a general observation about the subject.",
        "Take those items from the source block and from nothing else. If a detail the instruction asks for is missing there, omit it for that item rather than inventing it — and never add an item that is not listed.",
        "Where this conflicts with the ideal length above, completeness wins: stay within the channel's maximum, and if the full list will not fit, compress each item to the bare details rather than dropping items.",
        "Your coreMessage must state what the list as a whole says (how many items, of what kinds), not a claim about a single one of them.",
      ].join("\n")
    : "";

  return [
    intro,
    feedSection,
    recentSection,
    recentVisualSection,
    angleSection,
    patternSection,
    topicSection,
    aspectSection,
    // Last of the constraint sections, so it is the nearest instruction to the
    // JSON format block — and so it wins any tension with the angle/pattern
    // rotation above, which shapes HOW the post reads, not WHAT it is about.
    sharedTopicSection,
    // …and after even that: a shared topic decides WHICH story every channel
    // tells, while this decides what the post must actually contain. A sibling
    // channel of a digest is still a digest.
    extractionSection,
    buildJsonFormatInstruction(imageRequired),
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ─── Retry prompt ─────────────────────────────────────────────────────────────

export interface RetryContext {
  candidateText: string;
  /** The near-verbatim (Jaccard) match, if any. Empty string when none. */
  matchedText: string;
  /** Jaccard similarity of the near-verbatim match. */
  similarityScore: number;
  /**
   * Present when the retry was triggered by a SEMANTIC duplicate: the previous
   * attempt's central claim was too close to an existing post's. The model must
   * produce a substantially different central claim, not merely reword.
   */
  semanticDuplicate?: {
    repeatedCoreMessage: string;
    similarity: number;
  };
  /**
   * Present when the retry was triggered because the previous coreMessage was
   * generic praise. The model must replace it with a specific, testable claim.
   */
  genericCoreMessage?: {
    previousCoreMessage: string;
  };
  /**
   * Present when the retry was triggered because the previous attempt's topic
   * repeated a recently-used subject (Topic Memory). Holds the previous topic so
   * the model is told exactly which subject to move away from.
   */
  repeatedTopic?: string;
  /**
   * Present when the retry was triggered by a failed post-generation compliance
   * check — in practice, a banned term in the text. Unlike every other retry
   * reason, this one must NOT change the angle, pattern, or content aspect:
   * none of them caused the violation, so rotating them would churn the post
   * while leaving the offending word to be written again.
   */
  complianceFailure?: { reasons: string[]; failures: ComplianceFailure[] };
  /** When provided the retry prompt forces the model to use this angle. */
  forcedAngle?: ContentAngle;
  /** When provided the retry prompt forces the model to use this writing pattern. */
  forcedPattern?: PostPattern;
  /** When provided the retry prompt forces the model to use this content aspect. */
  forcedAspect?: ContentAspect;
}

export function buildRetryUserPrompt(baseUserPrompt: string, retry: RetryContext): string {
  const forcedLines: string[] = [];
  if (retry.forcedAngle) {
    forcedLines.push(`**Angle: ${retry.forcedAngle}** — ${ANGLE_INSTRUCTIONS[retry.forcedAngle]}`);
  }
  if (retry.forcedPattern) {
    const { hookType, structure, ctaType } = retry.forcedPattern;
    forcedLines.push(`**Hook: ${hookType}** — ${HOOK_INSTRUCTIONS[hookType]}`);
    forcedLines.push(`**Structure: ${structure}** — ${STRUCTURE_INSTRUCTIONS[structure]}`);
    forcedLines.push(`**CTA: ${ctaType}** — ${CTA_INSTRUCTIONS[ctaType]}`);
  }
  if (retry.forcedAspect) {
    forcedLines.push(
      `**Content aspect focus: ${retry.forcedAspect.focus}** — Your imagePrompt MUST visually anchor to: ${retry.forcedAspect.visualConcept}`
    );
  }

  const forcedBlock =
    forcedLines.length > 0
      ? [
          "## FORCED CONTENT PATTERN — overrides every angle, hook, structure, and CTA instruction below",
          ...forcedLines,
          "These supersede anything stated further in this prompt.",
        ].join("\n")
      : "";

  // Near-verbatim (Jaccard) match block — only when there is a matched post.
  const nearVerbatimBlock = retry.matchedText
    ? ["## The existing post it was too similar to", "---", retry.matchedText, "---", ""].join("\n")
    : "";

  // Generic-coreMessage block — the previous central claim was broad praise.
  const genericCoreBlock = retry.genericCoreMessage
    ? [
        "## Your previous central claim was too generic",
        "The previous coreMessage was broad destination/product praise, not a specific claim:",
        "---",
        retry.genericCoreMessage.previousCoreMessage,
        "---",
        "Replace it with ONE specific, testable claim that the source content supports.",
        "- Do NOT use praise phrases like 'ideal place', 'perfect choice', 'unforgettable experience', 'something for everyone' unless you immediately give a concrete, verifiable reason.",
        "- Anchor the claim to a concrete detail: a specific fact, number, feature, audience need, or takeaway from the source.",
        "- Do not merely restate the article title or topic.",
        "",
      ].join("\n")
    : "";

  // Repeated-topic block (Topic Memory) — the conceptual subject was reused.
  const repeatedTopicBlock = retry.repeatedTopic
    ? [
        "## You reused a recently-covered topic",
        "The previous attempt's topic repeats a subject already used in a recent post:",
        "---",
        retry.repeatedTopic,
        "---",
        "Choose a MEANINGFULLY DIFFERENT conceptual topic. Do not restate the same subject with new wording — cover a genuinely different angle or aspect from the source content.",
        "",
      ].join("\n")
    : "";

  // Semantic-duplicate block — the central CLAIM was repeated, not just wording.
  const semanticBlock = retry.semanticDuplicate
    ? [
        `## Semantic duplicate — your previous central claim was too close (cosine ${retry.semanticDuplicate.similarity.toFixed(2)}) to an existing post`,
        "Existing central claim that was repeated:",
        "---",
        retry.semanticDuplicate.repeatedCoreMessage,
        "---",
        "You MUST make a SUBSTANTIALLY DIFFERENT central claim (coreMessage): a genuinely different point or takeaway.",
        "A different hook, CTA, wording, or structure is NOT enough — the underlying idea itself must be different.",
        "",
      ].join("\n")
    : "";

  // Compliance-failure block — the text broke a hard content rule (a banned
  // term). Nothing about its angle/hook/structure/CTA is at issue.
  const complianceBlock = retry.complianceFailure
    ? (() => {
        const failures = retry.complianceFailure.failures ?? [];
        const remediationLines = failures.map((f) => `  - ${getRemediationGuidance(f)}`).join("\n");
        return [
          "## It broke a hard content rule",
          ...retry.complianceFailure.reasons.map((r) => `- ${r}`),
          ...(remediationLines ? ["", "## How to fix these failures:", remediationLines] : []),
          "",
        ].join("\n");
      })()
    : "";

  // A retry caused ONLY by a failed compliance check needs the OPPOSITE framing
  // of every other retry reason below: every other trigger tells the model to
  // switch away from the rejected attempt (different angle, different hook,
  // different claim). A compliance failure is a banned term — the post itself
  // was fine, so the fix is surgical and everything else must stay put. Only
  // take this branch when nothing else also fired.
  const complianceOnly =
    retry.complianceFailure &&
    !retry.forcedAngle &&
    !retry.forcedPattern &&
    !retry.semanticDuplicate &&
    !retry.genericCoreMessage &&
    !retry.repeatedTopic &&
    !retry.matchedText;

  if (complianceOnly) {
    const failures = retry.complianceFailure?.failures ?? [];
    const remediationLines = failures.map((f) => `• ${getRemediationGuidance(f)}`);

    const complianceOnlyBlock = [
      `⚠ REGENERATION REQUIRED (the post broke a hard content rule).`,
      "",
      "## Rejected attempt",
      "---",
      retry.candidateText,
      "---",
      "",
      "## What was wrong",
      ...retry.complianceFailure!.reasons.map((r) => `- ${r}`),
      "",
      ...(remediationLines.length > 0 ? ["## How to fix it", ...remediationLines, ""] : []),
      "## What you MUST do",
      "Keep the EXACT SAME angle, hook, structure, CTA, topic, and content aspect as the rejected attempt above — none of them caused this, and changing them would lose a post that was otherwise fine.",
      "Rewrite only what it takes to satisfy every rule listed above, preserving the meaning of the original.",
    ].join("\n");
    return `${complianceOnlyBlock}\n\n${baseUserPrompt}`;
  }

  const retryBlock = [
    `⚠ REGENERATION REQUIRED (too close to an existing post).`,
    "",
    "## Rejected attempt",
    "---",
    retry.candidateText,
    "---",
    "",
    nearVerbatimBlock,
    semanticBlock,
    genericCoreBlock,
    repeatedTopicBlock,
    complianceBlock,
    forcedBlock,
    "## What you must NOT do",
    "- Do not paraphrase the rejected attempt.",
    "- Do not reuse the same hook type or opening sentence.",
    "- Do not reuse the same angle, core message, or argument.",
    "- Do not reuse the same post structure or flow.",
    "- Do not reuse the same call to action.",
    "- Do not substitute synonyms — that is still paraphrasing.",
    "",
    "## What you MUST do",
    "Build the new post entirely around the forced angle, hook, structure, and CTA above.",
    "The first sentence must be unrecognisable compared to the rejected attempt and the existing post.",
    "This new post should feel like a different social media campaign, not a rewrite.",
  ]
    .filter(Boolean)
    .join("\n");

  return `${retryBlock}\n\n${baseUserPrompt}`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * `primary` is the resolved PrimarySelection's item — the article this post is
 * about. It is a required argument rather than something derived from `ctx`
 * because the caller is the only place that knows which item the reservation
 * actually claimed. Pass null for a mission/brand post.
 */
export function buildPrompts(
  ctx: GenerationContext,
  primary: FeedItemContext | null,
  contentLanguage?: string,
  recentPosts: RecentPostContext[] = [],
  diversity?: PromptDiversityHints
): BuiltPrompts {
  return {
    systemPrompt: buildSystemPrompt(ctx, contentLanguage),
    userPrompt: buildUserPrompt(ctx, primary, contentLanguage, recentPosts, diversity),
  };
}
