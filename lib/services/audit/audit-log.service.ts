import { prisma } from "@/lib/db/client";
import { Prisma } from "@prisma/client";

// ─── Action constants ──────────────────────────────────────────────────────────
// Plain strings — no enum — so future phases can add new actions without migrations.

export const AUDIT_ACTIONS = {
  POST_GENERATED: "POST_GENERATED",
  POST_SUBMITTED: "POST_SUBMITTED",
  POST_APPROVED: "POST_APPROVED",
  POST_REJECTED: "POST_REJECTED",
  POST_EDITED: "POST_EDITED",
  /**
   * A draft was permanently deleted, together with everything that existed only
   * because it did. The Post row is gone, so this log line — which survives, on
   * the company — is the only remaining record that it ever existed.
   */
  POST_DELETED: "POST_DELETED",
  POST_VERSION_RESTORED: "POST_VERSION_RESTORED",
  POST_PUBLISHED: "POST_PUBLISHED",
  POST_PUBLISH_FAILED: "POST_PUBLISH_FAILED",
  /**
   * The publisher declined to send a post it had otherwise selected — today only
   * for a manual schedule whose time is long past. Distinct from
   * POST_PUBLISH_FAILED: nothing was attempted and nothing broke, so it must not
   * read as a delivery error or enter the retry budget.
   */
  POST_PUBLISH_SKIPPED: "POST_PUBLISH_SKIPPED",
  /** A person moved a post's scheduledFor — the way out of a missed slot. */
  POST_RESCHEDULED: "POST_RESCHEDULED",
  /** One manual "generate N posts" request, recorded once for the whole batch. */
  POST_BULK_GENERATED: "POST_BULK_GENERATED",
  MEDIA_ATTACHED: "MEDIA_ATTACHED",
  CONTENT_MIX_UPDATED: "CONTENT_MIX_UPDATED",
  // v2-7 analytics. The key itself is never logged — only its last 4 characters.
  ANALYTICS_KEY_SET: "ANALYTICS_KEY_SET",
  ANALYTICS_KEY_REMOVED: "ANALYTICS_KEY_REMOVED",
} as const;

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface CreateAuditLogInput {
  companyId: string;
  userId?: string;
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditLogItem {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  user: { id: string; name: string | null; email: string } | null;
}

export interface ListAuditLogsFilters {
  action?: string;
  postId?: string;
  userId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

// ─── Service ───────────────────────────────────────────────────────────────────

/**
 * Best-effort: never throws. Logs errors internally so callers don't need try/catch.
 */
export async function createAuditLog(input: CreateAuditLogInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        companyId: input.companyId,
        userId: input.userId ?? null,
        action: input.action,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        metadata: input.metadata ? (input.metadata as Prisma.InputJsonValue) : Prisma.JsonNull,
      },
    });
  } catch (err) {
    console.error("[audit-log] Failed to write audit log:", err);
  }
}

export async function listCompanyAuditLogs(
  companyId: string,
  filters: ListAuditLogsFilters = {}
): Promise<AuditLogItem[]> {
  const { action, postId, userId, from, to, limit = 50 } = filters;

  const rows = await prisma.auditLog.findMany({
    where: {
      companyId,
      ...(action ? { action } : {}),
      ...(postId ? { entityId: postId, entityType: "post" } : {}),
      ...(userId ? { userId } : {}),
      ...((from ?? to)
        ? {
            createdAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(limit, 200),
    select: {
      id: true,
      action: true,
      entityType: true,
      entityId: true,
      metadata: true,
      createdAt: true,
      user: { select: { id: true, name: true, email: true } },
    },
  });

  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    metadata: r.metadata !== null ? (r.metadata as Record<string, unknown>) : null,
    createdAt: r.createdAt.toISOString(),
    user: r.user,
  }));
}

export async function listPostAuditLogs(postId: string): Promise<AuditLogItem[]> {
  const rows = await prisma.auditLog.findMany({
    where: { entityId: postId, entityType: "post" },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      action: true,
      entityType: true,
      entityId: true,
      metadata: true,
      createdAt: true,
      user: { select: { id: true, name: true, email: true } },
    },
  });

  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    metadata: r.metadata !== null ? (r.metadata as Record<string, unknown>) : null,
    createdAt: r.createdAt.toISOString(),
    user: r.user,
  }));
}
