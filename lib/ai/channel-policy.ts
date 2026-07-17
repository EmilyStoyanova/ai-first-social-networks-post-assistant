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
        id: "facebook_conversational_tone",
        description: "Facebook audiences typically respond better to a conversational tone.",
        promptFragment: "Write a conversational, engaging post.",
      },
      {
        severity: "WARNING",
        id: "facebook_length",
        description: "Shorter Facebook posts are generally recommended practice.",
        promptFragment: "Ideal length: 40–250 characters. Maximum: 500 characters.",
      },
      {
        severity: "SUGGESTION",
        id: "facebook_emoji_use",
        description: "Occasional emojis may add warmth without reading as noisy.",
        promptFragment: "Emojis are welcome but use sparingly.",
      },
      {
        severity: "SUGGESTION",
        id: "facebook_hashtag_count",
        description: "A small number of hashtags is the usual practice on Facebook.",
        promptFragment: "Include 1–3 relevant hashtags at the end if they add value.",
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
