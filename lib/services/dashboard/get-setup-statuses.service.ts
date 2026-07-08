import { prisma } from "@/lib/db/client";

export interface CompanySetupStatus {
  brandDescribed: boolean;
  bufferConnected: boolean;
  profilesSynced: boolean;
  hasEnabledChannel: boolean;
}

export function isSetupComplete(s: CompanySetupStatus): boolean {
  return s.bufferConnected && s.profilesSynced && s.hasEnabledChannel;
}

export async function getSetupStatuses(
  companyIds: string[]
): Promise<Map<string, CompanySetupStatus>> {
  if (companyIds.length === 0) return new Map();

  const [guidelines, bufferConnections, enabledChannels] = await Promise.all([
    prisma.brandGuidelines.findMany({
      where: { companyId: { in: companyIds }, companyDescription: { not: null } },
      select: { companyId: true },
    }),
    prisma.bufferConnection.findMany({
      where: { companyId: { in: companyIds } },
      select: { companyId: true, lastProfileSyncAt: true },
    }),
    prisma.channelConfig.findMany({
      where: { companyId: { in: companyIds }, enabled: true, isActive: true },
      select: { companyId: true },
      distinct: ["companyId"],
    }),
  ]);

  const guidelineSet = new Set(guidelines.map((g) => g.companyId));
  const bufferMap = new Map(bufferConnections.map((b) => [b.companyId, b.lastProfileSyncAt]));
  const enabledSet = new Set(enabledChannels.map((c) => c.companyId));

  return new Map(
    companyIds.map((id) => {
      const sync = bufferMap.get(id);
      return [
        id,
        {
          brandDescribed: guidelineSet.has(id),
          bufferConnected: bufferMap.has(id),
          profilesSynced: sync != null,
          hasEnabledChannel: enabledSet.has(id),
        },
      ];
    })
  );
}
