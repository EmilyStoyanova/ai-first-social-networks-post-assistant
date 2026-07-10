import { prisma } from "@/lib/db/client";
import type { FeedItemRow } from "./list-feed-items.service";

export type ToggleFeedItemResult =
  { success: true; item: FeedItemRow } | { success: false; code: "NOT_FOUND" | "FORBIDDEN" };

// ─── Minimal DB interface for testability ─────────────────────────────────────

export interface ToggleFeedItemDb {
  company: {
    findUnique: (args: {
      where: { slug: string };
      select: { id: true };
    }) => Promise<{ id: string } | null>;
  };
  companyMember: {
    findFirst: (args: {
      where: { company: { slug: string }; userId: string };
      select: { companyId: true; role: true };
    }) => Promise<{ companyId: string; role: string } | null>;
  };
  feedItem: {
    findFirst: (args: {
      where: { id: string; sourceId: string; companyId: string };
      select: { id: true };
    }) => Promise<{ id: string } | null>;
    update: (args: {
      where: { id: string };
      data: { enabled: boolean };
      select: {
        id: true;
        sourceId: true;
        title: true;
        content: true;
        url: true;
        publishedAt: true;
        enabled: true;
        createdAt: true;
      };
    }) => Promise<{
      id: string;
      sourceId: string;
      title: string | null;
      content: string | null;
      url: string;
      publishedAt: Date | null;
      enabled: boolean;
      createdAt: Date;
    }>;
  };
}

// ─── Core logic ───────────────────────────────────────────────────────────────

export async function toggleFeedItemCore(
  slug: string,
  sourceId: string,
  itemId: string,
  enabled: boolean,
  userId: string,
  isGlobalAdmin: boolean,
  db: ToggleFeedItemDb
): Promise<ToggleFeedItemResult> {
  let companyId: string;

  if (isGlobalAdmin) {
    const company = await db.company.findUnique({ where: { slug }, select: { id: true } });
    if (!company) return { success: false, code: "NOT_FOUND" };
    companyId = company.id;
  } else {
    const membership = await db.companyMember.findFirst({
      where: { company: { slug }, userId },
      select: { companyId: true, role: true },
    });
    if (!membership) return { success: false, code: "NOT_FOUND" };
    if (membership.role !== "owner") return { success: false, code: "FORBIDDEN" };
    companyId = membership.companyId;
  }

  const existing = await db.feedItem.findFirst({
    where: { id: itemId, sourceId, companyId },
    select: { id: true },
  });
  if (!existing) return { success: false, code: "NOT_FOUND" };

  const row = await db.feedItem.update({
    where: { id: itemId },
    data: { enabled },
    select: {
      id: true,
      sourceId: true,
      title: true,
      content: true,
      url: true,
      publishedAt: true,
      enabled: true,
      createdAt: true,
    },
  });

  return {
    success: true,
    item: {
      id: row.id,
      sourceId: row.sourceId,
      title: row.title,
      content: row.content,
      url: row.url,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      enabled: row.enabled,
      createdAt: row.createdAt.toISOString(),
    },
  };
}

// ─── Public API (uses real Prisma) ────────────────────────────────────────────

export async function toggleFeedItem(
  slug: string,
  sourceId: string,
  itemId: string,
  enabled: boolean,
  userId: string,
  isGlobalAdmin: boolean
): Promise<ToggleFeedItemResult> {
  return toggleFeedItemCore(slug, sourceId, itemId, enabled, userId, isGlobalAdmin, prisma);
}
