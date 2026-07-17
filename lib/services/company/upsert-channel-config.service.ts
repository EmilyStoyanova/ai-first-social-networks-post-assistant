import { prisma } from "@/lib/db/client";
import type { UpsertChannelConfigInput } from "@/lib/validators/channel-config.schema";
import type { ChannelConfigItem, PostingWindow } from "./list-channel-configs.service";
import { validateContentMix, type MixValidationCode } from "@/lib/scheduling/content-mix";
import type { SocialChannel } from "@prisma/client";

export type UpsertChannelConfigResult =
  | { success: true; config: ChannelConfigItem }
  | { success: false; code: "NOT_FOUND" | "FORBIDDEN" | MixValidationCode; message?: string };

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
    select: { companyId: true, channel: true },
  });
  if (!existing || existing.companyId !== companyId) {
    return { success: false, code: "NOT_FOUND" };
  }

  // ── Content-mix guard (v2-8) ──────────────────────────────────────────────
  // A saved mix can be invalidated from this side too: raising a channel's
  // weekly budget, or enabling a second channel on a different budget, breaks
  // the "quotas sum to the target" rule without touching a single quota. The
  // mix is the explicit user configuration and the scheduler follows it, so a
  // change that would leave the two contradicting each other is rejected here
  // rather than silently generating a distribution nobody asked for.
  //
  // Companies with no mix are unaffected: validateContentMix returns valid.
  const mixError = await validateAgainstContentMix(companyId, existing.channel, data);
  if (mixError) return { success: false, code: mixError.code, message: mixError.message };

  const row = await prisma.channelConfig.update({
    where: { id: configId },
    data: {
      enabled: data.enabled,
      imageRequired: data.imageRequired,
      includeSourceLink: data.includeSourceLink,
      autoGenerateImage: data.autoGenerateImage,
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

/**
 * Checks whether this channel edit would contradict the company's saved content
 * mix, projecting the edit onto the current enabled-channel set first. Returns
 * null when the result is fine (including when no mix is configured).
 */
async function validateAgainstContentMix(
  companyId: string,
  channel: SocialChannel,
  data: UpsertChannelConfigInput
): Promise<{ code: MixValidationCode; message: string } | null> {
  const [sources, company, otherChannels] = await Promise.all([
    prisma.contentSource.findMany({
      where: { companyId },
      select: { id: true, name: true, enabled: true, postsPerWeek: true, fallbackPolicy: true },
    }),
    prisma.company.findUnique({
      where: { id: companyId },
      select: { companyContentPostsPerWeek: true },
    }),
    prisma.channelConfig.findMany({
      where: { companyId, enabled: true, postsPerWeek: { gt: 0 }, channel: { not: channel } },
      select: { channel: true, postsPerWeek: true },
    }),
  ]);

  // The enabled-channel set as it would be AFTER this save.
  const channelTargets: Array<{ channel: string; postsPerWeek: number }> = [...otherChannels];
  if (data.enabled && data.postsPerWeek > 0) {
    channelTargets.push({ channel, postsPerWeek: data.postsPerWeek });
  }

  const validation = validateContentMix({
    sources,
    companyContentPostsPerWeek: company?.companyContentPostsPerWeek ?? null,
    channelTargets,
  });

  return validation.valid ? null : validation.error;
}
