import type { FeedItemContext, GenerationContext } from "./types";
import { selectPrimaryFeedItem } from "./primary-feed-item";
import { type ContentAngle, ANGLE_INSTRUCTIONS } from "./content-angle";
import {
  type PostPattern,
  HOOK_INSTRUCTIONS,
  STRUCTURE_INSTRUCTIONS,
  CTA_INSTRUCTIONS,
} from "./post-pattern";
import type { ContentAspect } from "./content-aspect";

export interface BuiltPrompts {
  systemPrompt: string;
  userPrompt: string;
}

export interface RecentPostContext {
  text: string;
}

export interface PromptDiversityHints {
  angle?: ContentAngle;
  pattern?: PostPattern;
  /** Topics declared by recent posts — model is instructed to avoid these. */
  recentTopics?: readonly string[];
  /** Dynamically mined content aspect — mandatory conceptual constraint for the post. */
  aspect?: ContentAspect;
}

// ─── Channel metadata ─────────────────────────────────────────────────────────

const CHANNEL_LABELS: Record<string, string> = {
  facebook: "Facebook",
  linkedin: "LinkedIn",
  instagram: "Instagram",
  tiktok: "TikTok",
};

const CHANNEL_RULES: Record<string, string> = {
  facebook: [
    "Write a conversational, engaging post.",
    "Ideal length: 40–250 characters. Maximum: 500 characters.",
    "Emojis are welcome but use sparingly.",
    "Include 1–3 relevant hashtags at the end if they add value.",
  ].join("\n"),
  linkedin: [
    "Write a professional, thought-leadership post.",
    "Ideal length: 150–300 characters. Maximum: 700 characters.",
    "Avoid excessive emojis. Use at most one per post.",
    "End with 3–5 relevant professional hashtags.",
    "Use a hook in the first line to stop the scroll.",
  ].join("\n"),
  instagram: [
    "Write a visual-first, energetic caption.",
    "First 125 characters must be compelling (shown before 'more').",
    "Use emojis freely to enhance the message.",
    "Include 5–10 relevant hashtags at the end on a new line.",
    "Maximum caption length: 400 characters (excluding hashtags).",
  ].join("\n"),
  tiktok: [
    "Write an extremely short, punchy caption.",
    "Maximum 150 characters including hashtags.",
    "Use trendy, conversational language.",
    "Include a clear call to action.",
    "End with 2–3 trending hashtags.",
  ].join("\n"),
};

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

  const channelSection = section(
    `Channel: ${channelLabel}`,
    lines(
      CHANNEL_RULES[channel.channel] ?? "",
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
      "- Do not fabricate facts. Use only what the provided content supports.",
      "- Return ONLY a JSON object — no markdown fences, no explanation, no extra text."
    )
  );

  const coreMessageSection = section(
    "Core Message — Mandatory",
    lines(
      'Every post must be built around a single core message. The "coreMessage" field of the JSON response must contain it.',
      "- It must be exactly one sentence.",
      "- It must state the central claim or takeaway the reader should remember — the point the post argues or reveals.",
      "- It must stand on its own, independent of the hook, opening line, or call to action.",
      "- It is NOT a summary of the source article, and NOT the topic label. Do not merely name the subject.",
      `- Write it in the same language as the post text (${lang}).`,
      'Example — topic: "marketing automation"',
      'Bad: "Marketing automation." (that is the topic, not a claim)',
      'Bad: "This post talks about marketing automation." (a meta description, not a claim)',
      'Good: "Automating repetitive marketing work gives small businesses more time for strategic growth."'
    )
  );

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
    channelSection,
    automationSection,
    writingRules,
    coreMessageSection,
    bulgarianQualitySection,
  ].filter(Boolean);

  return parts.join("\n\n");
}

// ─── User prompt ──────────────────────────────────────────────────────────────

const CONTENT_PER_ITEM_LIMIT = 900;
const TOTAL_FEED_CHAR_LIMIT = 5000;

/** Renders a feed item as a `**title**` + trimmed excerpt block (empty when it has neither). */
function excerptFor(item: FeedItemContext): string {
  const title = item.title?.trim() ?? "";
  const raw = item.content?.trim() ?? "";
  const excerpt =
    raw.length > CONTENT_PER_ITEM_LIMIT ? raw.slice(0, CONTENT_PER_ITEM_LIMIT) + "…" : raw;
  return [title ? `**${title}**` : null, excerpt || null].filter(Boolean).join("\n");
}

function buildJsonFormatInstruction(imageRequired: boolean): string {
  const imagePromptLine = imageRequired
    ? `  "imagePrompt": "REQUIRED — concise English visual description for an image generation model (no text, no emojis, no hashtags, no UI instructions; always in English regardless of post language)"`
    : `  "imagePrompt": "optional — if provided, must be a concise English visual description for an image generation model (no text, no emojis, no hashtags; always in English regardless of post language)"`;

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
  contentLanguage?: string,
  recentPosts: RecentPostContext[] = [],
  diversity?: PromptDiversityHints
): string {
  const { channel, feedItems } = ctx;
  const channelLabel = CHANNEL_LABELS[channel.channel] ?? channel.channel;
  const lang = (contentLanguage ?? channel.postingLanguage).toUpperCase();
  const imageRequired = channel.imageRequired;

  // One explicit primary feed item is selected here — the post must be built
  // around it, and its URL (same item) is appended by the service afterwards.
  // Any other feed items are provided only as clearly-separated background.
  const primary = selectPrimaryFeedItem(feedItems);

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

    const primarySection = [
      "**PRIMARY SOURCE ARTICLE — the post MUST be based on THIS article and no other.**",
      "The topic, facts, and angle of the post must come from this article. A link to this exact article will be attached to the post, so the post text must be about it.",
      "---",
      primaryBlock || "(no excerpt available for the primary article)",
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

  const intro =
    feedItems.length === 0
      ? `Create an original ${channelLabel} post for ${ctx.company.name}.\nWrite in ${lang}.`
      : `Write a ${channelLabel} post for ${ctx.company.name}.`;

  const { angle, pattern, recentTopics, aspect } = diversity ?? {};

  const angleSection = angle ? `**Content angle: ${angle}**\n${ANGLE_INSTRUCTIONS[angle]}` : "";

  const patternSection = pattern
    ? [
        `**Hook: ${pattern.hookType}**\n${HOOK_INSTRUCTIONS[pattern.hookType]}`,
        `**Structure: ${pattern.structure}**\n${STRUCTURE_INSTRUCTIONS[pattern.structure]}`,
        `**CTA: ${pattern.ctaType}**\n${CTA_INSTRUCTIONS[pattern.ctaType]}`,
      ].join("\n\n")
    : "";

  const topicSection =
    recentTopics && recentTopics.length > 0
      ? [
          "**Topic guidance**",
          "The following subjects have been covered recently — choose a meaningfully different one:",
          recentTopics.map((t) => `- ${t}`).join("\n"),
        ].join("\n")
      : "";

  const aspectSection = aspect
    ? [
        "**Content aspect — mandatory conceptual constraint**",
        `Focus: ${aspect.focus}`,
        "You MUST build this post around this specific focus. Do NOT replace it with a more prominent theme from the source content. The focus is the conceptual core of this post, not a suggestion.",
        `Your imagePrompt MUST visually anchor to: ${aspect.visualConcept}`,
      ].join("\n")
    : "";

  return [
    intro,
    feedSection,
    recentSection,
    angleSection,
    patternSection,
    topicSection,
    aspectSection,
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

export function buildPrompts(
  ctx: GenerationContext,
  contentLanguage?: string,
  recentPosts: RecentPostContext[] = [],
  diversity?: PromptDiversityHints
): BuiltPrompts {
  return {
    systemPrompt: buildSystemPrompt(ctx, contentLanguage),
    userPrompt: buildUserPrompt(ctx, contentLanguage, recentPosts, diversity),
  };
}
