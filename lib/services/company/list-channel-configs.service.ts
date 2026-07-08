import { prisma } from "@/lib/db/client";

export interface PostingWindow {
  day: string;
  start: string;
  end: string;
}

export interface ChannelConfigItem {
  id: string;
  channel: string;
  bufferProfileId: string | null;
  bufferProfileName: string | null;
  enabled: boolean;
  imageRequired: boolean;
  postingLanguage: string;
  postsPerDay: number;
  postsPerWeek: number;
  postingWindows: PostingWindow[];
  automationModeOverride: string | null;
  updatedAt: string | null;
}

const SELECT = {
  id: true,
  channel: true,
  bufferProfileId: true,
  bufferProfileName: true,
  enabled: true,
  imageRequired: true,
  postingLanguage: true,
  postsPerDay: true,
  postsPerWeek: true,
  postingWindows: true,
  automationModeOverride: true,
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

  const rows = await prisma.channelConfig.findMany({
    where: { companyId, isActive: true },
    select: SELECT,
    orderBy: [{ channel: "asc" }, { bufferProfileName: "asc" }],
  });

  const configs: ChannelConfigItem[] = rows.map((row) => ({
    id: row.id,
    channel: row.channel,
    bufferProfileId: row.bufferProfileId,
    bufferProfileName: row.bufferProfileName,
    enabled: row.enabled,
    imageRequired: row.imageRequired ?? false,
    postingLanguage: row.postingLanguage,
    postsPerDay: row.postsPerDay,
    postsPerWeek: row.postsPerWeek,
    postingWindows: (row.postingWindows as PostingWindow[] | null) ?? [],
    automationModeOverride: row.automationModeOverride ?? null,
    updatedAt: row.updatedAt.toISOString(),
  }));

  return { success: true, configs };
}
