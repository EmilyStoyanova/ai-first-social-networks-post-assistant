import { prisma } from "@/lib/db/client";
import type { ContentSourceInput } from "@/lib/validators/content-source.schema";
import type { ContentSourceConfig, ContentSourceItem } from "./list-content-sources.service";
import { runSourceIngestion } from "./ingest-content-source.service";

export type CreateContentSourceResult =
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

export async function createContentSource(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean,
  data: ContentSourceInput
): Promise<CreateContentSourceResult> {
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

  const row = await prisma.contentSource.create({
    data: {
      companyId,
      type: data.type,
      name: data.name,
      config: data.config as object,
      enabled: data.enabled ?? true,
    },
    select: SELECT,
  });

  // A prompt source has no external feed to poll — its feed item is derived
  // purely from promptText. Materialize it immediately (reusing the shared
  // ingestion core) so the source is usable for generation right away; article
  // sources are ingested lazily by the manual/cron ingest instead. Best-effort:
  // a failure here must not fail source creation — the next ingest retries.
  if (row.type === "prompt") {
    try {
      await runSourceIngestion(
        { id: row.id, type: row.type, name: row.name, config: row.config },
        companyId
      );
    } catch (err) {
      console.error(
        `[content-source] Immediate prompt ingestion failed for ${row.id} (non-fatal):`,
        err instanceof Error ? err.message : err
      );
    }
  }

  return {
    success: true,
    source: {
      id: row.id,
      type: row.type,
      name: row.name,
      config: row.config as ContentSourceConfig,
      enabled: row.enabled,
      lastFetchedAt: row.lastFetchedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    },
  };
}
