import { prisma } from "@/lib/db/client";

export interface PostingWindow {
  day: string;
  start: string;
  end: string;
}

export interface ChannelConfigItem {
  channel: string;
  enabled: boolean;
  imageRequired: boolean;
  postingLanguage: string;
  postsPerDay: number;
  postsPerWeek: number;
  postingWindows: PostingWindow[];
  automationModeOverride: string | null;
  bufferProfileId: string | null;
  updatedAt: string | null;
}

const CHANNELS = ["facebook", "linkedin", "instagram", "tiktok"] as const;

type Channel = (typeof CHANNELS)[number];

const DEFAULTS: Record<Channel, Omit<ChannelConfigItem, "channel" | "updatedAt">> = {
  facebook: {
    enabled: false,
    postsPerDay: 1,
    postsPerWeek: 5,
    postingLanguage: "en",
    imageRequired: true,
    automationModeOverride: null,
    bufferProfileId: null,
    postingWindows: [],
  },
  linkedin: {
    enabled: false,
    postsPerDay: 1,
    postsPerWeek: 5,
    postingLanguage: "en",
    imageRequired: false,
    automationModeOverride: null,
    bufferProfileId: null,
    postingWindows: [],
  },
  instagram: {
    enabled: false,
    postsPerDay: 1,
    postsPerWeek: 5,
    postingLanguage: "en",
    imageRequired: true,
    automationModeOverride: null,
    bufferProfileId: null,
    postingWindows: [],
  },
  tiktok: {
    enabled: false,
    postsPerDay: 1,
    postsPerWeek: 3,
    postingLanguage: "en",
    imageRequired: true,
    automationModeOverride: null,
    bufferProfileId: null,
    postingWindows: [],
  },
};

const SELECT = {
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
} as const;

export type ListChannelConfigsResult =
  { success: true; configs: ChannelConfigItem[] } | { success: false; code: "NOT_FOUND" };

export async function listChannelConfigs(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<ListChannelConfigsResult> {
  let companyId: string;

  if (isGlobalAdmin) {
    const company = await prisma.company.findUnique({ where: { slug }, select: { id: true } });
    if (!company) return { success: false, code: "NOT_FOUND" };
    companyId = company.id;
  } else {
    const membership = await prisma.companyMember.findFirst({
      where: { company: { slug }, userId },
      select: { companyId: true },
    });
    if (!membership) return { success: false, code: "NOT_FOUND" };
    companyId = membership.companyId;
  }

  const rows = await prisma.channelConfig.findMany({ where: { companyId }, select: SELECT });
  const rowMap = new Map(rows.map((r) => [r.channel as Channel, r]));

  const configs: ChannelConfigItem[] = CHANNELS.map((channel) => {
    const row = rowMap.get(channel);
    if (!row) return { channel, ...DEFAULTS[channel], updatedAt: null };
    return {
      channel: row.channel,
      enabled: row.enabled,
      imageRequired: row.imageRequired ?? DEFAULTS[channel].imageRequired,
      postingLanguage: row.postingLanguage,
      postsPerDay: row.postsPerDay,
      postsPerWeek: row.postsPerWeek,
      postingWindows: (row.postingWindows as PostingWindow[] | null) ?? [],
      automationModeOverride: row.automationModeOverride ?? null,
      bufferProfileId: row.bufferProfileId,
      updatedAt: row.updatedAt.toISOString(),
    };
  });

  return { success: true, configs };
}
