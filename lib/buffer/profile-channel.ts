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

/** As much of a Buffer profile as the channel guard needs to judge it. */
export interface ProfileChannelCandidate {
  id: string;
  name: string;
  /** Buffer's own service string — "facebook", "instagram-business", … */
  service: string;
}

export type ProfileChannelCheck =
  | { ok: true }
  | {
      ok: false;
      /** UNKNOWN_PROFILE = Buffer does not list it; CHANNEL_MISMATCH = wrong network. */
      code: "UNKNOWN_PROFILE" | "CHANNEL_MISMATCH";
      message: string;
    };

/**
 * Whether `profileId` may carry a post on `channel`.
 *
 * The authority is the SERVICE Buffer reports for the target profile, never this
 * company's own `ChannelConfig.channel` — a post stored as `instagram` has been
 * observed going out on a Facebook page (care-tech, 2026-08-14), and a check
 * that reads our own column cannot see that. This is the ONE implementation of
 * the question, shared by the manual publish action and the cron sender, so the
 * two can never answer it differently.
 *
 * An unrecognised service is refused: it is not provably the post's network, and
 * publishing to the wrong one cannot be undone.
 */
export function checkProfileChannel(
  profiles: readonly ProfileChannelCandidate[],
  profileId: string,
  channel: string
): ProfileChannelCheck {
  const target = profiles.find((p) => p.id === profileId);
  if (!target) {
    return {
      ok: false,
      code: "UNKNOWN_PROFILE",
      message: "That Buffer profile is not connected to this account.",
    };
  }

  const profileChannel = bufferServiceToChannel(target.service);
  if (profileChannel !== channel.toLowerCase()) {
    return {
      ok: false,
      code: "CHANNEL_MISMATCH",
      message:
        `This is a ${channel.toUpperCase()} post, but "${target.name}" is a ` +
        `${(profileChannel ?? target.service).toUpperCase()} profile. ` +
        `Choose a ${channel.toUpperCase()} profile instead.`,
    };
  }

  return { ok: true };
}
