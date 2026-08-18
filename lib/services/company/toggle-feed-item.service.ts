import { prisma } from "@/lib/db/client";
import { resolveItemPublicUrl } from "@/lib/ai/source-types";
import { summarizeClassificationError } from "@/lib/posts/feed-item-classification-filter";
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
        translationStatus: true;
        translationLanguage: true;
        translationError: true;
        // Read back unchanged — the toggle never writes them. Enabling or
        // disabling is a HUMAN decision and is independent of the verdict.
        classification: true;
        classificationStatus: true;
        classificationRejectionReason: true;
        classificationMatchedTopics: true;
        classificationReason: true;
        classificationError: true;
        // Never written here either — a person including or excluding an article
        // does not un-consume it.
        usedInPost: true;
        // Rides along on the row's own relation — no extra query. Needed only to
        // resolve `publicUrl` the same way listFeedItems does, so the toggled
        // row and the listed row describe the same link.
        source: { select: { config: true } };
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
      translationStatus: string | null;
      translationLanguage: string | null;
      translationError: string | null;
      classification: string | null;
      classificationStatus: string | null;
      classificationRejectionReason: string | null;
      classificationMatchedTopics: string[];
      classificationReason: string | null;
      classificationError: string | null;
      usedInPost: boolean;
      source: { config: unknown };
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
      translationStatus: true,
      translationLanguage: true,
      translationError: true,
      // Read back unchanged. Enabling or disabling an article is a HUMAN
      // decision and deliberately does not touch its verdict: the two are
      // independent, and a person who re-enables a REJECTED article has
      // overruled the classifier without rewriting what it said.
      classification: true,
      classificationStatus: true,
      classificationRejectionReason: true,
      classificationMatchedTopics: true,
      classificationReason: true,
      classificationError: true,
      usedInPost: true,
      source: { select: { config: true } },
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
      publicUrl: resolveItemPublicUrl(row.url, row.source.config),
      publishedAt: row.publishedAt?.toISOString() ?? null,
      enabled: row.enabled,
      createdAt: row.createdAt.toISOString(),
      translationStatus: row.translationStatus,
      translationLanguage: row.translationLanguage,
      translationError: row.translationError,
      classification: row.classification,
      classificationStatus: row.classificationStatus,
      classificationRejectionReason: row.classificationRejectionReason,
      classificationMatchedTopics: row.classificationMatchedTopics,
      classificationReason: row.classificationReason,
      // Summarised exactly as listFeedItems does, so a row does not change shape
      // when it is toggled.
      classificationError: summarizeClassificationError(row.classificationError),
      usedInPost: row.usedInPost,
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
