import { IMAGE_STYLE_INSTRUCTIONS, type ImageStyle } from "./image-style";

const CHANNEL_HINTS: Record<string, { dimensions: string; style: string }> = {
  instagram: {
    dimensions: "square 1:1 format",
    style: "vibrant colors, lifestyle aesthetic, visually striking",
  },
  linkedin: {
    dimensions: "landscape 16:9 format",
    style: "professional, clean, corporate-friendly",
  },
  facebook: {
    dimensions: "landscape 1.91:1 format",
    style: "engaging, colorful, attention-grabbing",
  },
  tiktok: {
    dimensions: "vertical 9:16 format",
    style: "bold, dynamic, youthful energy",
  },
};

const SAFETY_SUFFIX =
  "No text overlays. No logos or watermarks. No faces. Photorealistic, high quality, social-media-optimized.";

// Animated images must not be described as "Photorealistic" — that contradicts
// the animated style instruction. Same safety rules, without the realism word.
const ANIMATED_SAFETY_SUFFIX =
  "No text overlays. No logos or watermarks. No faces. High quality, social-media-optimized.";

export function buildImagePrompt(params: {
  basePrompt: string;
  channel: string;
  forbiddenWords: string[];
  imageStyle?: ImageStyle;
}): string {
  const { basePrompt, channel, forbiddenWords, imageStyle } = params;

  let safePrompt = basePrompt;
  for (const word of forbiddenWords) {
    if (!word) continue;
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    safePrompt = safePrompt
      .replace(new RegExp(escaped, "gi"), "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  const hints = CHANNEL_HINTS[channel.toLowerCase()];
  const parts: string[] = [safePrompt];
  if (hints) {
    parts.push(`Style: ${hints.style}.`);
    parts.push(`Format: ${hints.dimensions}.`);
  }
  // `default` (or omitted) leaves the prompt identical to the legacy output.
  if (imageStyle && imageStyle !== "default") {
    parts.push(IMAGE_STYLE_INSTRUCTIONS[imageStyle]);
  }
  parts.push(imageStyle === "animated" ? ANIMATED_SAFETY_SUFFIX : SAFETY_SUFFIX);

  return parts.join(" ");
}
