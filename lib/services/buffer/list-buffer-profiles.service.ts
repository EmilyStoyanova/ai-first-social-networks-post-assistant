import { getBufferClient } from "@/lib/buffer/buffer-provider";
import type { BufferProfile } from "@/lib/buffer/buffer-client";
import {
  BufferNoConnectionError,
  BufferApiError,
  BufferTokenExpiredError,
} from "@/lib/buffer/buffer-errors";
import { bufferServiceToChannel, filterProfilesByChannel } from "@/lib/buffer/profile-channel";
import { MOCK_BUFFER_PROFILES } from "@/lib/buffer/mock-profiles";
import { checkBufferAccess } from "./_access";

export interface BufferProfileItem {
  id: string;
  name: string;
  /** Uppercase SocialChannel value, matching `Post.channel` as the API returns it. */
  channel: string;
}

export interface ListBufferProfilesOptions {
  /**
   * Restrict the list to one social network — the channel of the post about to
   * be published.
   *
   * A Facebook post has no business being sent to an Instagram profile, so the
   * choice is never offered. `approveAndPublishPost` refuses the pairing too;
   * this only keeps the selector from proposing what the server would reject.
   */
  channel?: string;
}

export type ListBufferProfilesResult =
  | { success: true; profiles: BufferProfileItem[] }
  | {
      success: false;
      code: "NOT_FOUND" | "FORBIDDEN" | "NO_CONNECTION" | "TOKEN_EXPIRED" | "BUFFER_API_ERROR";
      message?: string;
    };

/**
 * A Buffer profile as the browser sees it.
 *
 * An unrecognised service keeps its raw name, so such a profile is still listed
 * (and still labelled) when no channel filter is applied — a channel filter
 * drops it, because nothing can vouch for which network it is.
 */
function toItem(profile: BufferProfile): BufferProfileItem {
  const channel = bufferServiceToChannel(profile.service) ?? profile.service;
  return { id: profile.id, name: profile.name, channel: channel.toUpperCase() };
}

export async function listBufferProfiles(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean,
  options: ListBufferProfilesOptions = {}
): Promise<ListBufferProfilesResult> {
  const access = await checkBufferAccess(slug, userId, isGlobalAdmin);
  if (!access.ok) return { success: false, code: access.error };

  const restrict = (profiles: BufferProfileItem[]): BufferProfileItem[] =>
    options.channel ? filterProfilesByChannel(profiles, options.channel) : profiles;

  if (process.env.AI_MOCK_MODE === "true") {
    return { success: true, profiles: restrict(MOCK_BUFFER_PROFILES.map(toItem)) };
  }

  try {
    const client = await getBufferClient(access.companyId);
    const raw = await client.getProfiles();

    return { success: true, profiles: restrict(raw.map(toItem)) };
  } catch (err) {
    if (err instanceof BufferNoConnectionError) {
      return { success: false, code: "NO_CONNECTION" };
    }
    if (err instanceof BufferTokenExpiredError) {
      return { success: false, code: "TOKEN_EXPIRED", message: err.message };
    }
    if (err instanceof BufferApiError) {
      return { success: false, code: "BUFFER_API_ERROR", message: err.message };
    }
    throw err;
  }
}
