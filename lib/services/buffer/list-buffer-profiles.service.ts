import { getBufferClient } from "@/lib/buffer/buffer-provider";
import {
  BufferNoConnectionError,
  BufferApiError,
  BufferTokenExpiredError,
} from "@/lib/buffer/buffer-errors";
import { checkBufferAccess } from "./_access";

const MOCK_PROFILES = [
  { id: "mock-profile-fb", name: "Mock Facebook Page", channel: "FACEBOOK" },
  { id: "mock-profile-li", name: "Mock LinkedIn Company", channel: "LINKEDIN" },
  { id: "mock-profile-ig", name: "Mock Instagram Account", channel: "INSTAGRAM" },
];

const SERVICE_TO_CHANNEL: Record<string, string> = {
  facebook: "FACEBOOK",
  linkedin: "LINKEDIN",
  instagram: "INSTAGRAM",
  tiktok: "TIKTOK",
  twitter: "TWITTER",
};

export interface BufferProfileItem {
  id: string;
  name: string;
  channel: string;
}

export type ListBufferProfilesResult =
  | { success: true; profiles: BufferProfileItem[] }
  | {
      success: false;
      code: "NOT_FOUND" | "FORBIDDEN" | "NO_CONNECTION" | "TOKEN_EXPIRED" | "BUFFER_API_ERROR";
      message?: string;
    };

export async function listBufferProfiles(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<ListBufferProfilesResult> {
  const access = await checkBufferAccess(slug, userId, isGlobalAdmin);
  if (!access.ok) return { success: false, code: access.error };

  if (process.env.AI_MOCK_MODE === "true") {
    return { success: true, profiles: MOCK_PROFILES };
  }

  try {
    const client = await getBufferClient(access.companyId);
    const raw = await client.getProfiles();

    const profiles: BufferProfileItem[] = raw.map((p) => ({
      id: p.id,
      name: p.name,
      channel: SERVICE_TO_CHANNEL[p.service.toLowerCase()] ?? p.service.toUpperCase(),
    }));

    return { success: true, profiles };
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
