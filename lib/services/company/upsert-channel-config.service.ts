import { prisma } from "@/lib/db/client";
import type { UpsertChannelConfigInput } from "@/lib/validators/channel-config.schema";
import type { ChannelConfigItem, PostingWindow } from "./list-channel-configs.service";

const VALID_CHANNELS = ["facebook", "linkedin", "instagram", "tiktok"] as const;

export type UpsertChannelConfigResult =
  | { success: true; config: ChannelConfigItem }
  | { success: false; code: "NOT_FOUND" | "FORBIDDEN" | "INVALID_CHANNEL" };

export async function upsertChannelConfig(
  slug: string,
  channel: string,
  userId: string,
  isGlobalAdmin: boolean,
  data: UpsertChannelConfigInput
): Promise<UpsertChannelConfigResult> {
  const normalizedChannel = channel.toLowerCase();
  if (!VALID_CHANNELS.includes(normalizedChannel as (typeof VALID_CHANNELS)[number])) {
    return { success: false, code: "INVALID_CHANNEL" };
  }

  let companyId: string;

  if (isGlobalAdmin) {
    const company = await prisma.company.findUnique({ where: { slug }, select: { id: true } });
    if (!company) return { success: false, code: "NOT_FOUND" };
    companyId = company.id;
  } else {
    const membership = await prisma.companyMember.findFirst({
      where: { company: { slug }, userId },
      select: { companyId: true, role: true },
    });
    if (!membership) return { success: false, code: "NOT_FOUND" };
    if (membership.role !== "owner") return { success: false, code: "FORBIDDEN" };
    companyId = membership.companyId;
  }

  const payload = {
    enabled: data.enabled,
    imageRequired: data.imageRequired,
    postingLanguage: data.language,
    postsPerDay: data.postsPerDay,
    postsPerWeek: data.postsPerWeek,
    postingWindows: (data.postingWindows ?? []) as object[],
    automationModeOverride: data.automationModeOverride ?? null,
    bufferProfileId: data.bufferProfileId ?? null,
  };

  const row = await prisma.channelConfig.upsert({
    where: {
      companyId_channel: {
        companyId,
        channel: normalizedChannel as (typeof VALID_CHANNELS)[number],
      },
    },
    create: {
      companyId,
      channel: normalizedChannel as (typeof VALID_CHANNELS)[number],
      ...payload,
    },
    update: payload,
    select: {
      channel: true,
      enabled: true,
      imageRequired: true,
      postingLanguage: true,
      postsPerDay: true,
      postsPerWeek: true,
      postingWindows: true,
      automationModeOverride: true,
      bufferProfileId: true,
      updatedAt: true,
    },
  });

  const config: ChannelConfigItem = {
    channel: row.channel,
    enabled: row.enabled,
    imageRequired: row.imageRequired ?? false,
    postingLanguage: row.postingLanguage,
    postsPerDay: row.postsPerDay,
    postsPerWeek: row.postsPerWeek,
    postingWindows: (row.postingWindows as PostingWindow[] | null) ?? [],
    automationModeOverride: row.automationModeOverride ?? null,
    bufferProfileId: row.bufferProfileId,
    updatedAt: row.updatedAt.toISOString(),
  };

  return { success: true, config };
}
