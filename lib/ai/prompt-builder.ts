import type { GenerationContext } from "./types";

export interface BuiltPrompts {
  systemPrompt: string;
  userPrompt: string;
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

function buildSystemPrompt(ctx: GenerationContext): string {
  const { company, brand, channel } = ctx;
  const channelLabel = CHANNEL_LABELS[channel.channel] ?? channel.channel;
  const lang = channel.postingLanguage.toUpperCase();
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

  const writingRules = section(
    "Writing Rules",
    lines(
      `- Write entirely in ${lang}.`,
      "- Stay within the brand voice described above.",
      "- Never include URLs unless specifically requested.",
      brand?.forbiddenWords.length
        ? `- Never use these words: ${brand.forbiddenWords.join(", ")}.`
        : "",
      "- Do not fabricate facts. Use only what the provided content supports.",
      "- Return ONLY a JSON object — no markdown fences, no explanation, no extra text."
    )
  );

  const parts = [
    `You are a professional social media content creator for ${company.name}.`,
    companySection,
    brandSection,
    channelSection,
    automationSection,
    writingRules,
  ].filter(Boolean);

  return parts.join("\n\n");
}

// ─── User prompt ──────────────────────────────────────────────────────────────

const CONTENT_PER_ITEM_LIMIT = 900;
const TOTAL_FEED_CHAR_LIMIT = 5000;

const JSON_FORMAT_INSTRUCTION = `Return ONLY a JSON object in this exact format (no markdown, no explanation):
{
  "text": "the post text",
  "hashtags": ["tag1", "tag2"],
  "imagePrompt": "visual description for image generation (optional, omit if not relevant)",
  "notes": "brief creative rationale (optional)"
}`;

function buildUserPrompt(ctx: GenerationContext): string {
  const { channel, feedItems } = ctx;
  const channelLabel = CHANNEL_LABELS[channel.channel] ?? channel.channel;

  if (feedItems.length === 0) {
    return [
      `Create an original ${channelLabel} post for ${ctx.company.name}.`,
      `Write in ${channel.postingLanguage.toUpperCase()}.`,
      JSON_FORMAT_INSTRUCTION,
    ].join("\n\n");
  }

  // Build feed excerpt, newest first, respecting total char budget
  let budget = TOTAL_FEED_CHAR_LIMIT;
  const excerpts: string[] = [];

  for (const item of feedItems) {
    if (budget <= 0) break;

    const title = item.title?.trim() ?? "";
    const raw = item.content?.trim() ?? "";
    const excerpt =
      raw.length > CONTENT_PER_ITEM_LIMIT ? raw.slice(0, CONTENT_PER_ITEM_LIMIT) + "…" : raw;

    const block = [title ? `**${title}**` : null, excerpt || null].filter(Boolean).join("\n");

    if (!block) continue;

    const cost = block.length + 10; // +10 for separator overhead
    if (cost > budget) break;
    budget -= cost;
    excerpts.push(block);
  }

  const feedSection =
    excerpts.length > 0
      ? `Use the following content as inspiration:\n\n---\n${excerpts.join("\n---\n")}\n---`
      : "";

  return [
    `Write a ${channelLabel} post for ${ctx.company.name}.`,
    feedSection,
    JSON_FORMAT_INSTRUCTION,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function buildPrompts(ctx: GenerationContext): BuiltPrompts {
  return {
    systemPrompt: buildSystemPrompt(ctx),
    userPrompt: buildUserPrompt(ctx),
  };
}
