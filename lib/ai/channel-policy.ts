/**
 * Channel policy model (v2-3) — the single source of truth for every
 * platform-specific claim in the app.
 *
 * Two kinds of knowledge live here, and the difference is the point of the file:
 *
 * - `PlatformConstraint` (BLOCKING) — verified platform/API behaviour that WILL
 *   cause a publish failure. Enforced before Buffer is called. Never injected
 *   into a prompt: a constraint blocks, it does not advise.
 * - `GenerationHint` (WARNING | SUGGESTION) — best-practice guidance injected
 *   into the system prompt. Never blocks anything.
 *
 * Rules for editing this file:
 * - Only add a BLOCKING constraint you can verify against the Buffer API or
 *   official platform documentation. Record the evidence in `source`.
 * - Hint wording must stay hedged ("typically", "may improve", "recommended").
 *   Never assert algorithm/ranking effects as fact ("increases reach by 30%").
 */
import type { SocialChannel } from "@prisma/client";

export type PolicySeverity = "BLOCKING" | "WARNING" | "SUGGESTION";

/** The post fields any BLOCKING constraint is allowed to inspect. */
export interface PostForPolicyCheck {
  channel: SocialChannel;
  mediaAssetId: string | null;
}

export interface PlatformConstraint {
  /** BLOCKING = verified API/platform behaviour that will cause a publish failure. */
  severity: "BLOCKING";
  id: string;
  description: string;
  /** Where the claim was verified. Required — an unverifiable claim is a hint, not a constraint. */
  source: string;
  /** Returns true when the constraint is VIOLATED. */
  check: (post: PostForPolicyCheck) => boolean;
}

export interface GenerationHint {
  /** WARNING = strong recommendation; SUGGESTION = light best-practice tip. */
  severity: "WARNING" | "SUGGESTION";
  id: string;
  description: string;
  /** Injected verbatim into the system prompt's channel section. */
  promptFragment: string;
}

export interface ChannelPolicy {
  constraints: PlatformConstraint[];
  hints: GenerationHint[];
}

export interface PolicyViolation {
  id: string;
  description: string;
}

/**
 * Media is required, and we cannot verify anything narrower than "media is
 * attached": `MediaAsset` has no type/mime column and the app only ever
 * produces images (uploads are restricted to image/* and Cloudinary's image
 * endpoint). A "requires video" check is therefore not expressible today —
 * see the note on the TikTok policy below.
 */
function requiresMedia(post: PostForPolicyCheck): boolean {
  return !post.mediaAssetId;
}

/**
 * Hint order is load-bearing: fragments are injected into the prompt in array
 * order, and that order reproduces the pre-v2-3 `CHANNEL_RULES` text verbatim.
 * Reordering these changes the prompt, and therefore generation output.
 */
export const CHANNEL_POLICIES: Record<SocialChannel, ChannelPolicy> = {
  facebook: {
    // No BLOCKING constraint is verified for Facebook: text-only posts publish
    // fine through Buffer today.
    constraints: [],
    hints: [
      {
        severity: "WARNING",
        id: "facebook_first_line_hook",
        description:
          "The first 1–2 lines of a Facebook post appear before the 'See more' button; they are critical to engagement.",
        promptFragment:
          "Your opening 1–2 lines are critical — they appear before 'See more'. Start with a strong hook: a direct question, a surprising fact, a specific observation, or a clear benefit. Avoid generic, dramatic, or clickbait-style openings that feel artificial. The hook must feel natural and relevant to the source content.",
      },
      {
        severity: "WARNING",
        id: "facebook_mobile_formatting",
        description:
          "Facebook is primarily read on mobile; formatting and whitespace significantly affect readability.",
        promptFragment:
          "Format for mobile reading: use short paragraphs (1–2 sentences each), add blank lines between logical sections, and avoid dense text blocks. Whitespace should improve readability without making the post feel fragmented. Only use bullets or numbered lists when the content genuinely benefits from them, not as automatic decoration.",
      },
      {
        severity: "WARNING",
        id: "facebook_one_idea",
        description: "Each Facebook post should communicate one primary message effectively.",
        promptFragment:
          "Focus on ONE main idea. Do not try to cover product promotion, company history, educational advice, and news in a single post — every paragraph should support the central message. If the source covers multiple topics, select the most valuable angle for your audience.",
      },
      {
        severity: "WARNING",
        id: "facebook_conversational_tone",
        description:
          "Facebook audiences typically respond better to a conversational, authentic tone.",
        promptFragment:
          "Write a conversational, direct, and authentic post. Speak like a knowledgeable human, not a marketing template. Use the brand's configured form of address ('ти' or 'вие' in Bulgarian) consistently. Avoid corporate filler, generic AI wording, artificial excitement, and canned phrases.",
      },
      {
        severity: "WARNING",
        id: "facebook_audience_value",
        description:
          "Posts that explain why content matters to the reader drive more meaningful engagement than posts that only recite facts.",
        promptFragment:
          "Focus on audience value: explain why this matters, what practical benefit the reader gets, what problem it solves, or what decision it helps them make. Prefer concrete benefits and source-specific facts over generic promotional claims.",
      },
      {
        severity: "WARNING",
        id: "facebook_cta_meaningful",
        description:
          "A clear, relevant call to action that matches the post's purpose drives engagement better than generic engagement bait.",
        promptFragment:
          "End with a meaningful call to action that directly relates to your post. When a specific CTA type is assigned above, follow it exactly as instructed — do not deviate or reframe it. When no CTA is assigned, prefer specific requests (questions, comments, shares, or visits) that invite real engagement over canned phrases like 'A вие какво мислите?'",
      },
      {
        severity: "SUGGESTION",
        id: "facebook_emoji_use",
        description:
          "Moderate emoji use (0–2 per post) can add visual warmth without appearing noisy.",
        promptFragment:
          "Use emojis moderately (0–2 per post). Emojis should enhance readability or provide a visual accent, not replace words or decorate every paragraph. Respect the brand's voice if it requires more or fewer emojis.",
      },
      {
        severity: "SUGGESTION",
        id: "facebook_hashtag_count",
        description: "A small number of relevant hashtags is the usual practice on Facebook.",
        promptFragment:
          "Include 1–3 relevant hashtags at the end if they genuinely add value. Avoid hashtag bloat — Facebook users typically expect minimal tagging.",
      },
      {
        severity: "SUGGESTION",
        id: "facebook_avoid_template_writing",
        description:
          "Posts that feel formulaic (hook → filler → list → generic question) reduce effectiveness and feel inauthentic.",
        promptFragment:
          "Avoid template-like writing. Do not distort the content merely to satisfy a selected hook/structure pattern. The final post should feel like one coherent piece of writing, not a formula plugged into a template. Vary your structure and tone across posts to avoid repetitive patterns.",
      },
    ],
  },

  linkedin: {
    // No BLOCKING constraint is verified for LinkedIn: text-only posts publish
    // fine through Buffer today.
    constraints: [],
    hints: [
      {
        severity: "WARNING",
        id: "linkedin_professional_tone",
        description:
          "LinkedIn is a professional context; a thought-leadership register typically fits best.",
        promptFragment: "Write a professional, thought-leadership post.",
      },
      {
        severity: "WARNING",
        id: "linkedin_length",
        description: "Concise LinkedIn posts are generally recommended practice.",
        promptFragment: "Ideal length: 150–300 characters. Maximum: 700 characters.",
      },
      {
        severity: "SUGGESTION",
        id: "linkedin_emoji_use",
        description: "Heavy emoji use may read as unprofessional in this context.",
        promptFragment: "Avoid excessive emojis. Use at most one per post.",
      },
      {
        severity: "SUGGESTION",
        id: "linkedin_hashtag_count",
        description: "A few professional hashtags are the usual practice on LinkedIn.",
        promptFragment: "End with 3–5 relevant professional hashtags.",
      },
      {
        severity: "SUGGESTION",
        id: "linkedin_opening_hook",
        description: "An opening hook may improve the odds a reader stops scrolling.",
        promptFragment: "Use a hook in the first line to stop the scroll.",
      },
    ],
  },

  instagram: {
    constraints: [
      {
        severity: "BLOCKING",
        id: "instagram_requires_media",
        description: "Instagram posts require at least one image or video.",
        // Verified against the live Buffer API: createPost for an Instagram
        // channel without an asset fails with a MutationError, and
        // BufferClient.publishUpdate rejects it for the same reason.
        source: "Buffer GraphQL API (createPost MutationError, verified 2026-07-06)",
        check: requiresMedia,
      },
    ],
    hints: [
      {
        severity: "WARNING",
        id: "instagram_visual_first_tone",
        description: "Instagram is a visual-first medium; captions typically support the image.",
        promptFragment: "Write a visual-first, energetic caption.",
      },
      {
        severity: "WARNING",
        id: "instagram_first_125_chars",
        description:
          "Instagram truncates captions in-feed, so the opening typically carries the message.",
        promptFragment: "First 125 characters must be compelling (shown before 'more').",
      },
      {
        severity: "SUGGESTION",
        id: "instagram_emoji_use",
        description: "Emojis generally suit Instagram's register.",
        promptFragment: "Use emojis freely to enhance the message.",
      },
      {
        severity: "WARNING",
        id: "instagram_hashtag_count",
        description: "Instagram engagement typically benefits from relevant hashtags.",
        promptFragment: "Include 5–10 relevant hashtags at the end on a new line.",
      },
      {
        severity: "WARNING",
        id: "instagram_caption_length",
        description: "Long Instagram captions may lose the reader; a cap is recommended practice.",
        promptFragment: "Maximum caption length: 400 characters (excluding hashtags).",
      },
    ],
  },

  tiktok: {
    constraints: [
      {
        severity: "BLOCKING",
        id: "tiktok_requires_media",
        // Deliberately "media", not "video". TikTok posts are built from a
        // video or a photo set — a text-only post cannot exist — but this app
        // cannot express "is a video": MediaAsset has no type column and only
        // images are ever produced. Requiring media is the strongest claim that
        // is actually checkable, so it is the one made here. Narrowing this to
        // video needs a media-type column first (out of scope for v2-3).
        description: "TikTok posts require a media attachment.",
        source:
          "TikTok Content Posting API — a post is created from video or photo content; text-only posts are not supported (developers.tiktok.com)",
        check: requiresMedia,
      },
    ],
    hints: [
      {
        severity: "WARNING",
        id: "tiktok_caption_brevity",
        description: "TikTok captions are typically very short.",
        promptFragment: "Write an extremely short, punchy caption.",
      },
      {
        severity: "WARNING",
        id: "tiktok_length",
        description: "A tight caption cap is recommended practice on TikTok.",
        promptFragment: "Maximum 150 characters including hashtags.",
      },
      {
        severity: "SUGGESTION",
        id: "tiktok_tone",
        description: "A casual, trend-aware register generally suits TikTok.",
        promptFragment: "Use trendy, conversational language.",
      },
      {
        severity: "SUGGESTION",
        id: "tiktok_cta",
        description: "An explicit call to action may improve response.",
        promptFragment: "Include a clear call to action.",
      },
      {
        severity: "SUGGESTION",
        id: "tiktok_hashtag_count",
        description: "A couple of on-trend hashtags is the usual practice on TikTok.",
        promptFragment: "End with 2–3 trending hashtags.",
      },
    ],
  },
};

/**
 * Policy for a channel string. Returns null for a value outside the
 * SocialChannel enum — callers holding a plain `string` (the prompt builder's
 * ChannelContext) need a total function; callers holding a typed
 * `SocialChannel` should index CHANNEL_POLICIES directly.
 */
export function getChannelPolicy(channel: string): ChannelPolicy | null {
  return (CHANNEL_POLICIES as Record<string, ChannelPolicy | undefined>)[channel] ?? null;
}

/**
 * Returns the BLOCKING constraints this post violates — empty when it is safe
 * to publish. Callers must treat a non-empty result as "do not call Buffer".
 */
export function checkBlockingConstraints(post: PostForPolicyCheck): PolicyViolation[] {
  const policy = getChannelPolicy(post.channel);
  if (!policy) return [];
  return policy.constraints
    .filter((c) => c.severity === "BLOCKING" && c.check(post))
    .map((c) => ({ id: c.id, description: c.description }));
}
