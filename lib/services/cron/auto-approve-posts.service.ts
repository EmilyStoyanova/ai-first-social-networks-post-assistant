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

/**
 * Cron step 4 — promotes pending_approval posts to approved for channels
 * whose effective automation mode is fully_automated (channel override wins
 * over the company default). Safety-flagged posts are always held for human
 * review, regardless of automation mode.
 */
export async function autoApprovePosts(
  companyId: string,
  companyAutomationMode: "semi_automated" | "fully_automated"
): Promise<AutoApproveSummary> {
  const configs = await prisma.channelConfig.findMany({
    where: { companyId, enabled: true },
    select: { channel: true, automationModeOverride: true },
  });

  const automatedChannels: SocialChannel[] = configs
    .filter((c) => (c.automationModeOverride ?? companyAutomationMode) === "fully_automated")
    .map((c) => c.channel);

  if (automatedChannels.length === 0) {
    return { approved: 0, heldForReview: 0, channels: [] };
  }

  const candidates = await prisma.post.findMany({
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
    await prisma.post.updateMany({
      where: { id: { in: toApprove.map((p) => p.id) } },
      data: { status: "approved", approvedAt: new Date() },
    });

    for (const post of toApprove) {
      await createAuditLog({
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
