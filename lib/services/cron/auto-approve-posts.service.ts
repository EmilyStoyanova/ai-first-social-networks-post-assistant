import { prisma } from "@/lib/db/client";
import type { SocialChannel } from "@prisma/client";
import { createAuditLog, AUDIT_ACTIONS } from "@/lib/services/audit/audit-log.service";

/** Keeps a single run bounded even for large approval backlogs. */
const MAX_APPROVALS_PER_RUN = 50;

export interface AutoApproveSummary {
  approved: number;
  heldForReview: number;
  channels: string[];
}

// ─── Minimal DB interface for testability ─────────────────────────────────────
// Mirrors generate-draft-post.service.ts: the real Prisma client satisfies this
// narrow shape, and unit tests inject a fake that captures writes. This is the
// ONLY place in the system that approves a post without a human, so it is worth
// being able to test directly.

export interface AutoApproveDb {
  channelConfig: {
    findMany: (args: {
      where: { companyId: string; enabled: true };
      select: { channel: true; automationModeOverride: true };
    }) => Promise<Array<{ channel: SocialChannel; automationModeOverride: string | null }>>;
  };
  post: {
    findMany: (args: {
      where: { companyId: string; status: "pending_approval"; channel: { in: SocialChannel[] } };
      orderBy: { createdAt: "asc" };
      take: number;
      select: { id: true; channel: true; safetyFlagged: true };
    }) => Promise<Array<{ id: string; channel: SocialChannel; safetyFlagged: boolean }>>;
    updateMany: (args: {
      where: { id: { in: string[] } };
      data: { status: "approved"; approvedAt: Date };
    }) => Promise<{ count: number }>;
  };
}

export interface AutoApprovePostsDeps {
  db?: AutoApproveDb;
  auditLog?: typeof createAuditLog;
}

/**
 * Cron step 4 — promotes pending_approval posts to approved for channels
 * whose effective automation mode is fully_automated (channel override wins
 * over the company default). Safety-flagged posts are always held for human
 * review, regardless of automation mode.
 *
 * This is the single place automation may approve. Generation never does, so a
 * manually generated post cannot reach here — it is created as a draft and only
 * a person moves it forward.
 */
export async function autoApprovePosts(
  companyId: string,
  companyAutomationMode: "semi_automated" | "fully_automated",
  deps: AutoApprovePostsDeps = {}
): Promise<AutoApproveSummary> {
  const db = deps.db ?? prisma;
  const auditLog = deps.auditLog ?? createAuditLog;

  const configs = await db.channelConfig.findMany({
    where: { companyId, enabled: true },
    select: { channel: true, automationModeOverride: true },
  });

  const automatedChannels: SocialChannel[] = configs
    .filter((c) => (c.automationModeOverride ?? companyAutomationMode) === "fully_automated")
    .map((c) => c.channel);

  if (automatedChannels.length === 0) {
    return { approved: 0, heldForReview: 0, channels: [] };
  }

  const candidates = await db.post.findMany({
    where: {
      companyId,
      status: "pending_approval",
      channel: { in: automatedChannels },
    },
    orderBy: { createdAt: "asc" },
    take: MAX_APPROVALS_PER_RUN,
    select: { id: true, channel: true, safetyFlagged: true },
  });

  const toApprove = candidates.filter((p) => !p.safetyFlagged);
  const heldForReview = candidates.length - toApprove.length;

  if (toApprove.length > 0) {
    await db.post.updateMany({
      where: { id: { in: toApprove.map((p) => p.id) } },
      data: { status: "approved", approvedAt: new Date() },
    });

    for (const post of toApprove) {
      await auditLog({
        companyId,
        action: AUDIT_ACTIONS.POST_APPROVED,
        entityType: "post",
        entityId: post.id,
        metadata: { channel: post.channel, automated: true },
      });
    }
  }

  return {
    approved: toApprove.length,
    heldForReview,
    channels: automatedChannels,
  };
}
