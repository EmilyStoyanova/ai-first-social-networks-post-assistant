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

export function buildImagePrompt(params: {
  basePrompt: string;
  channel: string;
  forbiddenWords: string[];
}): string {
  const { basePrompt, channel, forbiddenWords } = params;

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
  parts.push(SAFETY_SUFFIX);

  return parts.join(" ");
}
