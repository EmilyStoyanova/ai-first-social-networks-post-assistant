import { prisma } from "@/lib/db/client";
import type { ContentSourceInput } from "@/lib/validators/content-source.schema";
import type { ContentSourceItem } from "./list-content-sources.service";

export type UpdateContentSourceResult =
  | { success: true; source: ContentSourceItem }
  | { success: false; code: "NOT_FOUND" | "FORBIDDEN" };

const SELECT = {
  id: true,
  type: true,
  name: true,
  config: true,
  enabled: true,
  lastFetchedAt: true,
  createdAt: true,
} as const;

export async function updateContentSource(
  slug: string,
  sourceId: string,
  userId: string,
  isGlobalAdmin: boolean,
  data: ContentSourceInput
): Promise<UpdateContentSourceResult> {
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

  const existing = await prisma.contentSource.findFirst({
    where: { id: sourceId, companyId },
    select: { enabled: true },
  });
  if (!existing) return { success: false, code: "NOT_FOUND" };

  const row = await prisma.contentSource.update({
    where: { id: sourceId },
    data: {
      name: data.name,
      config: data.config as object,
      enabled: data.enabled ?? existing.enabled,
    },
    select: SELECT,
  });

  return {
    success: true,
    source: {
      id: row.id,
      type: row.type,
      name: row.name,
      config: row.config as Record<string, string>,
      enabled: row.enabled,
      lastFetchedAt: row.lastFetchedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    },
  };
}
