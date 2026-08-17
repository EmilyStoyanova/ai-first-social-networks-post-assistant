import type { SocialChannel } from "@prisma/client";

/**
 * Buffer's `service` string → the social network that profile posts to.
 *
 * Buffer reports several service strings per network depending on the account
 * type (a Facebook group, an Instagram business or creator account, a LinkedIn
 * company page), so its raw value can never be compared with `Post.channel`
 * directly. This map is the ONE place that translation happens: profile sync,
 * the publish profile selector and the publish guard all read it, which is what
 * keeps "which network is this profile on?" from having two answers that drift.
 *
 * New service strings can be added here without touching anything else.
 */
const SERVICE_TO_CHANNEL: Record<string, SocialChannel> = {
  // Facebook
  facebook: "facebook",
  "facebook-group": "facebook",
  // Instagram (business / creator / personal)
  instagram: "instagram",
  "instagram-business": "instagram",
  instagrambusiness: "instagram",
  "instagram-creator": "instagram",
  instagramcreator: "instagram",
  // LinkedIn (personal / company page)
  linkedin: "linkedin",
  "linkedin-company": "linkedin",
  linkedincompany: "linkedin",
  "linkedin-page": "linkedin",
  // TikTok
  tiktok: "tiktok",
};

/**
 * The network a Buffer profile belongs to, or null when its service is not one
 * this app publishes to.
 *
 * Null is a refusal, not a shrug: a profile we cannot place on a network is not
 * provably the post's own network, and publishing to the wrong one cannot be
 * taken back.
 */
export function bufferServiceToChannel(service: string): SocialChannel | null {
  return SERVICE_TO_CHANNEL[service.toLowerCase().replace(/\s+/g, "-")] ?? null;
}

/**
 * The profiles that can carry a post on `channel`, in the order given.
 *
 * EVERY match survives — a company holding two Facebook pages must still choose
 * between them. Comparison is case-insensitive because channels travel
 * uppercase through the API and lowercase through Prisma.
 */
export function filterProfilesByChannel<T extends { channel: string }>(
  profiles: readonly T[],
  channel: string
): T[] {
  const target = channel.toLowerCase();
  return profiles.filter((p) => p.channel.toLowerCase() === target);
}
