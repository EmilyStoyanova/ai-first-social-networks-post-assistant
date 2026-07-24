import { z } from "zod";

/**
 * Supported image-generation styles.
 *
 * `default` preserves the original generation behaviour exactly. The other
 * values inject an explicit style instruction into the image prompt.
 */
export const IMAGE_STYLES = ["default", "realistic", "animated"] as const;

export type ImageStyle = (typeof IMAGE_STYLES)[number];

/** Zod schema for a single image style. Rejects any value outside the list. */
export const imageStyleSchema = z.enum(IMAGE_STYLES);

/** Upper bound on a user-supplied image prompt override. */
export const IMAGE_PROMPT_MAX_LENGTH = 2000;

/**
 * Zod schema for the generate-image request body.
 *
 * `imageStyle` selects a style preset. `imagePrompt`, when present, overrides
 * the post's stored prompt for this one generation (it is never persisted back
 * to the post). Empty/whitespace-only overrides are ignored by the service,
 * which falls back to the post's own prompt.
 */
export const generateImageRequestSchema = z.object({
  imageStyle: imageStyleSchema.optional(),
  imagePrompt: z.string().max(IMAGE_PROMPT_MAX_LENGTH).optional(),
});

/**
 * Prompt instructions appended for non-default styles. `default` is omitted on
 * purpose so its prompt stays byte-for-byte identical to the legacy output.
 */
export const IMAGE_STYLE_INSTRUCTIONS: Record<Exclude<ImageStyle, "default">, string> = {
  realistic:
    "Realistic style: true-to-life photographic realism, natural lighting, lifelike detail and textures.",
  animated:
    "Animated style: illustrated cartoon / animation aesthetic, stylized shapes, non-photorealistic rendering.",
};
