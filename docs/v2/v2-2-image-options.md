# v2-2 — Image Generation Style Options

## Goal

Let users choose a visual style, mood, and generation constraints when generating images for posts. All config is saved with the `MediaAsset` for auditability and regeneration.

## Schema Change

```prisma
model MediaAsset {
  // ... existing fields ...
  generationConfig Json? @map("generation_config")
}
```

Migration: `add_media_asset_generation_config`

## TypeScript Types

```typescript
type VisualStyle =
  | "photorealistic"
  | "editorial_photo"
  | "flat_illustration"
  | "vector_art"
  | "watercolor"
  | "comic"
  | "cinematic";

type ImageMood = "professional" | "energetic" | "calm" | "playful" | "dramatic" | "minimal";

interface ImageGenerationConfig {
  visualStyle?: VisualStyle;
  mood?: ImageMood;
  includesPeople?: boolean;
  textInImage?: boolean; // whether to try to include text overlays
  useBrandColors?: boolean; // inject primary/secondary color into prompt
  additionalInstructions?: string; // free-text, max 200 chars
}
```

`ImageGenerationConfig` is stored verbatim as `MediaAsset.generationConfig`.

## Service Changes

### `buildImagePrompt()` in `lib/ai/image/image-prompt-builder.ts`

Add `config?: ImageGenerationConfig` to the options parameter:

```typescript
const STYLE_PREFIXES: Record<VisualStyle, string> = {
  photorealistic: "ultra-realistic photograph,",
  editorial_photo: "editorial style photograph,",
  flat_illustration: "flat vector illustration, clean lines,",
  vector_art: "professional vector art,",
  watercolor: "watercolor painting, soft edges,",
  comic: "comic book art style, bold outlines,",
  cinematic: "cinematic still, dramatic lighting,",
};

const MOOD_SUFFIXES: Record<ImageMood, string> = {
  professional: "professional, corporate atmosphere",
  energetic: "vibrant, high-energy, dynamic",
  calm: "serene, soft light, tranquil",
  playful: "fun, bright colors, lighthearted",
  dramatic: "high contrast, moody, intense",
  minimal: "minimalist, clean, negative space",
};
```

Build order: `[STYLE_PREFIX] [CHANNEL_HINTS.styleHint] [basePrompt] [MOOD_SUFFIX] [brandColors?] [SAFETY_SUFFIX]`

Options not supported natively by the current provider (e.g., `useBrandColors`) are injected as descriptive text in the prompt.

### `generate-post-image.service.ts`

Accept `config?: ImageGenerationConfig` and thread it through to `buildImagePrompt()`. Save it in `MediaAsset.generationConfig` on asset creation.

## UI Changes

### `ImagePickerModal` — "AI Generate" tab

Add below the prompt input:

**Style** (chip selector, single-select, optional):
`Photorealistic | Editorial Photo | Flat Illustration | Vector Art | Watercolor | Comic | Cinematic`

**Mood** (dropdown, optional):
`Professional | Energetic | Calm | Playful | Dramatic | Minimal`

**Options** (checkboxes):

- Include people
- Text in image
- Use brand colors

**Additional instructions** (textarea, 200-char limit, optional)

All controls are optional. Omitting them produces a prompt identical to the current generation path.

## Acceptance Criteria

- [ ] Each `VisualStyle` value produces a distinct, non-empty prompt prefix
- [ ] Each `ImageMood` produces a distinct suffix
- [ ] `generationConfig` persisted in `MediaAsset.generationConfig` as JSON
- [ ] Generation with no config selected produces output identical to current behaviour
- [ ] `useBrandColors` reads from `BrandGuidelines.primaryColor` / `secondaryColor`; skipped when not set
- [ ] `additionalInstructions` capped at 200 characters before injection
- [ ] EN and BG i18n for all UI labels
- [ ] `npm run typecheck && npm run lint` clean

## Edge Cases

- Provider does not support native style parameters → entire config converted to prompt text; no API error
- `BrandGuidelines` not set and `useBrandColors = true` → silently skipped (no empty color string in prompt)
- `additionalInstructions` containing forbidden words → `SAFETY_SUFFIX` and `forbiddenWords` filter still applies
