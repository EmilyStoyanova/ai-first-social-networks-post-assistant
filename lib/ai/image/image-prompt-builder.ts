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

/**
 * Shared image-quality guidance, appended to EVERY generated image regardless of
 * channel, provider, image style, or manual/automatic path.
 *
 * Deliberately style-neutral: it describes composition and craft, never a medium,
 * so it does not push an `animated` image towards photorealism. It is phrased as
 * qualities to produce rather than defects to avoid — diffusion text encoders do
 * not represent negation, so "no deformed hands" tends to reinforce the very
 * thing it names. Exclusions live in the negative prompt below instead.
 */
export const QUALITY_SUFFIX =
  "Quality: clean, coherent composition with one clear subject separated from an uncluttered background; " +
  "physically plausible scene layout with consistent perspective, scale and lighting; " +
  "objects placed naturally and resting on solid surfaces; sharp focus and crisp, high-quality detail.";

/**
 * Added on top of `QUALITY_SUFFIX` only when the requested scene actually
 * contains people. Anatomy guidance is wasted context on a scene with nobody in
 * it, and naming body parts in such a prompt invites the model to draw them.
 */
export const PEOPLE_QUALITY_SUFFIX =
  "People: natural facial features and expressions, realistic body proportions and poses, " +
  "anatomically coherent hands and limbs with the correct number of fingers.";

/**
 * Words that mean a person is in the scene. Matched whole-word and
 * case-insensitively against the prompt after forbidden-word removal, so a scene
 * whose only human reference was stripped is treated as having no people.
 */
const PEOPLE_TERMS = [
  "person",
  "people",
  "human",
  "humans",
  "man",
  "men",
  "woman",
  "women",
  "boy",
  "boys",
  "girl",
  "girls",
  "child",
  "children",
  "kid",
  "kids",
  "teenager",
  "teenagers",
  "adult",
  "adults",
  "someone",
  "somebody",
  "crowd",
  "crowds",
  "couple",
  "family",
  "families",
  "audience",
  "team",
  "colleague",
  "colleagues",
  "coworker",
  "coworkers",
  "employee",
  "employees",
  "staff",
  "worker",
  "workers",
  "customer",
  "customers",
  "client",
  "clients",
  "founder",
  "founders",
  "entrepreneur",
  "entrepreneurs",
  "developer",
  "developers",
  "engineer",
  "engineers",
  "designer",
  "designers",
  "manager",
  "managers",
  "student",
  "students",
  "teacher",
  "teachers",
  "doctor",
  "doctors",
  "nurse",
  "nurses",
  "chef",
  "chefs",
  "athlete",
  "athletes",
  "speaker",
  "speakers",
  "presenter",
  "presenters",
  "attendee",
  "attendees",
  "participant",
  "participants",
  "businessman",
  "businesswoman",
  "portrait",
  "portraits",
  "face",
  "faces",
  "hand",
  "hands",
  "handshake",
  "selfie",
] as const;

const PEOPLE_PATTERN = new RegExp(`\\b(?:${PEOPLE_TERMS.join("|")})\\b`, "i");

/** Whether the described scene contains people, and so needs anatomy guidance. */
function mentionsPeople(prompt: string): boolean {
  return PEOPLE_PATTERN.test(prompt);
}

// The exclusions this line used to carry ("No text overlays. No logos or
// watermarks. No faces.") now live in the negative prompt. What is left is the
// only part that was ever a genuine instruction to the model.
const RENDER_SUFFIX = "Photorealistic, high quality, social-media-optimized.";

// Animated images must not be described as "Photorealistic" — that contradicts
// the animated style instruction.
const ANIMATED_RENDER_SUFFIX = "High quality, social-media-optimized.";

/**
 * Defects excluded from every image. Comma-separated keywords rather than
 * sentences: negative prompts are scored per-concept, so phrasing them as prose
 * only dilutes each term.
 */
export const NEGATIVE_PROMPT_BASE =
  "deformed anatomy, distorted proportions, floating or intersecting objects, " +
  "duplicated or cloned objects, impossible geometry, distorted perspective, " +
  "blurry, low quality, jpeg artifacts, text, caption, watermark, signature, logo";

/**
 * Added when the scene contains people. The positive prompt asks for good
 * anatomy (see `PEOPLE_QUALITY_SUFFIX`); this excludes the failure modes.
 */
export const NEGATIVE_PROMPT_PEOPLE =
  "malformed face, asymmetrical or misaligned eyes, bad hands, " +
  "extra or missing fingers, fused or malformed fingers, " +
  "extra or duplicated limbs, duplicated people";

/**
 * Added only when the scene contains NO people. This is where the old
 * "No faces." exclusion belongs: it keeps incidental strangers out of a product
 * or object shot, without ever firing on a scene that deliberately has people
 * in it — there we want good faces, not forbidden ones.
 */
export const NEGATIVE_PROMPT_NO_PEOPLE = "people, faces";

/** A positive prompt paired with the exclusions that go with it. */
export interface BuiltImagePrompt {
  prompt: string;
  negativePrompt: string;
}

export function buildImagePrompt(params: {
  basePrompt: string;
  channel: string;
  forbiddenWords: string[];
  imageStyle?: ImageStyle;
}): BuiltImagePrompt {
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
  // `default` (or omitted) adds no style instruction of its own — the two stay
  // byte-for-byte identical.
  if (imageStyle && imageStyle !== "default") {
    parts.push(IMAGE_STYLE_INSTRUCTIONS[imageStyle]);
  }
  // Quality guidance is unconditional: it must reach the `default` style too,
  // since that is the only style the automatic generation path ever uses.
  parts.push(QUALITY_SUFFIX);

  const hasPeople = mentionsPeople(safePrompt);
  if (hasPeople) {
    parts.push(PEOPLE_QUALITY_SUFFIX);
  }
  parts.push(imageStyle === "animated" ? ANIMATED_RENDER_SUFFIX : RENDER_SUFFIX);

  const negativeParts = [
    NEGATIVE_PROMPT_BASE,
    hasPeople ? NEGATIVE_PROMPT_PEOPLE : NEGATIVE_PROMPT_NO_PEOPLE,
  ];

  return {
    prompt: parts.join(" "),
    negativePrompt: negativeParts.join(", "),
  };
}
