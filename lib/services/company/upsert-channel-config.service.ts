import { prisma } from "@/lib/db/client";
import { postingDaysCoverTarget } from "@/lib/scheduling/posting-windows";
import type { UpsertChannelConfigInput } from "@/lib/validators/channel-config.schema";
import type { ChannelConfigItem, PostingWindow } from "./list-channel-configs.service";

export type UpsertChannelConfigResult =
  | { success: true; config: ChannelConfigItem }
  | {
      success: false;
      code: "NOT_FOUND" | "FORBIDDEN" | "INSUFFICIENT_POSTING_DAYS";
      message?: string;
    };

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

  // The posting-day rule, enforced again at the write itself.
  //
  // The request schema already refuses this combination, so in practice nothing
  // reaches here. It is repeated because this function is the ONLY way a
  // posting window is stored, and the rule it enforces is not a shape check
  // that a validator owns — it is the invariant the weekly cron depends on: a
  // channel may not ask for more posts a week than it configured days to put
  // them on. A future caller that skips the schema still cannot break it.
  if (!postingDaysCoverTarget(data.postsPerWeek, data.postingWindows ?? [])) {
    return { success: false, code: "INSUFFICIENT_POSTING_DAYS" };
  }

  // Verify the config belongs to this company.
  const existing = await prisma.channelConfig.findUnique({
    where: { id: configId },
    select: { companyId: true, channel: true },
  });
  if (!existing || existing.companyId !== companyId) {
    return { success: false, code: "NOT_FOUND" };
  }

  // A channel edit used to be validated against the company's saved content mix
  // here, on the theory that raising a weekly budget could break the mix's sum.
  // It no longer can: `postsPerWeek` decides how many posts this channel gets and
  // the mix decides only where they come from, resized to whatever this number
  // says (see mixForChannel). The two cannot contradict each other, so a
  // channel's cadence is free to change without an owner rebalancing quotas
  // first — and nothing on this side of the app can invalidate a mix.
  const row = await prisma.channelConfig.update({
    where: { id: configId },
    data: {
      enabled: data.enabled,
      imageRequired: data.imageRequired,
      includeSourceLink: data.includeSourceLink,
      autoGenerateImage: data.autoGenerateImage,
      // "inherit" is stored as NULL so the channel follows the brand default.
      postingLanguage: data.language === "inherit" ? null : data.language,
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
      autoGenerateImage: true,
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
    autoGenerateImage: row.autoGenerateImage,
    postingLanguage: row.postingLanguage,
    postsPerDay: row.postsPerDay,
    postsPerWeek: row.postsPerWeek,
    postingWindows: (row.postingWindows as PostingWindow[] | null) ?? [],
    automationModeOverride: row.automationModeOverride ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };

  return { success: true, config };
}
