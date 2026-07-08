import { prisma } from "@/lib/db/client";
import { getBufferClient } from "@/lib/buffer/buffer-provider";
import {
  BufferNoConnectionError,
  BufferApiError,
  BufferTokenExpiredError,
} from "@/lib/buffer/buffer-errors";
import type { SocialChannel } from "@prisma/client";

// Buffer returns various service strings depending on account/profile type.
// All known variants are mapped here; new ones can be added without other changes.
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

export interface SyncBufferProfilesStats {
  synced: number;
  deactivated: number;
}

export type SyncBufferProfilesResult =
  | { success: true; stats: SyncBufferProfilesStats }
  | {
      success: false;
      code: "NO_CONNECTION" | "TOKEN_EXPIRED" | "BUFFER_API_ERROR";
      message?: string;
    };

export async function syncBufferProfiles(companyId: string): Promise<SyncBufferProfilesResult> {
  let client: Awaited<ReturnType<typeof getBufferClient>>;
  try {
    client = await getBufferClient(companyId);
  } catch (err) {
    if (err instanceof BufferNoConnectionError) {
      return { success: false, code: "NO_CONNECTION" };
    }
    throw err;
  }

  let rawProfiles: Awaited<ReturnType<typeof client.getProfiles>>;
  try {
    rawProfiles = await client.getProfiles();
  } catch (err) {
    if (err instanceof BufferTokenExpiredError) {
      return { success: false, code: "TOKEN_EXPIRED", message: err.message };
    }
    if (err instanceof BufferApiError) {
      return { success: false, code: "BUFFER_API_ERROR", message: err.message };
    }
    throw err;
  }

  console.log(
    `[sync-profiles] companyId=${companyId} total profiles returned by Buffer: ${rawProfiles.length}`
  );

  const activeProfileIds = new Set<string>();
  let synced = 0;

  for (const profile of rawProfiles) {
    const serviceKey = profile.service.toLowerCase().replace(/\s+/g, "-");
    const channel = SERVICE_TO_CHANNEL[serviceKey];

    if (!channel) {
      console.log(
        `[sync-profiles] SKIP id=${profile.id} name="${profile.name}" service="${profile.service}" (serviceKey="${serviceKey}" not in SERVICE_TO_CHANNEL)`
      );
      continue;
    }

    console.log(
      `[sync-profiles] MAP  id=${profile.id} name="${profile.name}" service="${profile.service}" → channel=${channel}`
    );

    activeProfileIds.add(profile.id);

    await prisma.channelConfig.upsert({
      where: {
        companyId_bufferProfileId: {
          companyId,
          bufferProfileId: profile.id,
        },
      },
      create: {
        companyId,
        channel,
        bufferProfileId: profile.id,
        bufferProfileName: profile.name,
        isActive: true,
        enabled: false,
      },
      update: {
        bufferProfileName: profile.name,
        channel,
        isActive: true,
      },
    });

    synced++;
  }

  // Deactivate configs that are no longer present in Buffer,
  // including legacy configs that have no bufferProfileId.
  const deactivated = await prisma.channelConfig.updateMany({
    where: {
      companyId,
      isActive: true,
      OR: [
        { bufferProfileId: null },
        ...(activeProfileIds.size > 0
          ? [{ bufferProfileId: { notIn: [...activeProfileIds] } }]
          : []),
      ],
    },
    data: { isActive: false },
  });

  return { success: true, stats: { synced, deactivated: deactivated.count } };
}
