import { prisma } from "@/lib/db/client";

export interface ContentSourceItem {
  id: string;
  type: string;
  name: string;
  config: Record<string, string>;
  enabled: boolean;
  lastFetchedAt: string | null;
  createdAt: string;
}

export type ListContentSourcesResult =
  { success: true; sources: ContentSourceItem[] } | { success: false; code: "NOT_FOUND" };

function toItem(r: {
  id: string;
  type: string;
  name: string;
  config: unknown;
  enabled: boolean;
  lastFetchedAt: Date | null;
  createdAt: Date;
}): ContentSourceItem {
  return {
    id: r.id,
    type: r.type,
    name: r.name,
    config: r.config as Record<string, string>,
    enabled: r.enabled,
    lastFetchedAt: r.lastFetchedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

const SELECT = {
  id: true,
  type: true,
  name: true,
  config: true,
  enabled: true,
  lastFetchedAt: true,
  createdAt: true,
} as const;

export async function listContentSources(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<ListContentSourcesResult> {
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

  const rows = await prisma.contentSource.findMany({
    where: { companyId },
    orderBy: { createdAt: "asc" },
    select: SELECT,
  });

  return { success: true, sources: rows.map(toItem) };
}
