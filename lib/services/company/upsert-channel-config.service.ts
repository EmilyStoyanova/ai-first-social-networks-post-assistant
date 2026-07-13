import { prisma } from "@/lib/db/client";
import type { UpsertChannelConfigInput } from "@/lib/validators/channel-config.schema";
import type { ChannelConfigItem, PostingWindow } from "./list-channel-configs.service";

export type UpsertChannelConfigResult =
  | { success: true; config: ChannelConfigItem }
  | { success: false; code: "NOT_FOUND" | "FORBIDDEN" };

export async function upsertChannelConfig(
  slug: string,
  configId: string,
  userId: string,
  isGlobalAdmin: boolean,
  data: UpsertChannelConfigInput
): Promise<UpsertChannelConfigResult> {
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

  // Verify the config belongs to this company.
  const existing = await prisma.channelConfig.findUnique({
    where: { id: configId },
    select: { companyId: true },
  });
  if (!existing || existing.companyId !== companyId) {
    return { success: false, code: "NOT_FOUND" };
  }

  const row = await prisma.channelConfig.update({
    where: { id: configId },
    data: {
      enabled: data.enabled,
      imageRequired: data.imageRequired,
      includeSourceLink: data.includeSourceLink,
      postingLanguage: data.language,
      postsPerDay: data.postsPerDay,
      postsPerWeek: data.postsPerWeek,
      postingWindows: (data.postingWindows ?? []) as object[],
      automationModeOverride: data.automationModeOverride ?? null,
    },
    select: {
      id: true,
      channel: true,
      bufferProfileId: true,
      bufferProfileName: true,
      enabled: true,
      imageRequired: true,
      includeSourceLink: true,
      postingLanguage: true,
      postsPerDay: true,
      postsPerWeek: true,
      postingWindows: true,
      automationModeOverride: true,
      updatedAt: true,
    },
  });

  const config: ChannelConfigItem = {
    id: row.id,
    channel: row.channel,
    bufferProfileId: row.bufferProfileId,
    bufferProfileName: row.bufferProfileName,
    enabled: row.enabled,
    imageRequired: row.imageRequired ?? false,
    includeSourceLink: row.includeSourceLink,
    postingLanguage: row.postingLanguage,
    postsPerDay: row.postsPerDay,
    postsPerWeek: row.postsPerWeek,
    postingWindows: (row.postingWindows as PostingWindow[] | null) ?? [],
    automationModeOverride: row.automationModeOverride ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };

  return { success: true, config };
}
