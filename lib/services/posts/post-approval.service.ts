import { prisma } from "@/lib/db/client";

export type ApprovalError = "NOT_FOUND" | "FORBIDDEN" | "INVALID_TRANSITION";

export type ApprovalResult =
  { success: true; status: string } | { success: false; code: ApprovalError; message?: string };

async function resolveContext(
  postId: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<{ ok: false; code: "NOT_FOUND" } | { ok: true; postStatus: string; isOwner: boolean }> {
  const post = await prisma.post.findUnique({
    where: { id: postId },
    select: { companyId: true, status: true },
  });
  if (!post) return { ok: false, code: "NOT_FOUND" };

  if (isGlobalAdmin) {
    return { ok: true, postStatus: post.status, isOwner: true };
  }

  const membership = await prisma.companyMember.findFirst({
    where: { companyId: post.companyId, userId },
    select: { role: true },
  });
  if (!membership) return { ok: false, code: "NOT_FOUND" };

  return {
    ok: true,
    postStatus: post.status,
    isOwner: membership.role === "owner",
  };
}

export async function submitForApproval(
  postId: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<ApprovalResult> {
  const ctx = await resolveContext(postId, userId, isGlobalAdmin);
  if (!ctx.ok) return { success: false, code: ctx.code };

  if (ctx.postStatus !== "draft") {
    return {
      success: false,
      code: "INVALID_TRANSITION",
      message: `Only draft posts can be submitted for approval. Current status: ${ctx.postStatus.toUpperCase()}.`,
    };
  }

  await prisma.post.update({
    where: { id: postId },
    data: { status: "pending_approval" },
  });

  return { success: true, status: "PENDING_APPROVAL" };
}

export async function approvePost(
  postId: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<ApprovalResult> {
  const ctx = await resolveContext(postId, userId, isGlobalAdmin);
  if (!ctx.ok) return { success: false, code: ctx.code };

  if (!ctx.isOwner) return { success: false, code: "FORBIDDEN" };

  if (ctx.postStatus !== "pending_approval") {
    return {
      success: false,
      code: "INVALID_TRANSITION",
      message: `Only pending approval posts can be approved. Current status: ${ctx.postStatus.toUpperCase()}.`,
    };
  }

  await prisma.post.update({
    where: { id: postId },
    data: { status: "approved", approvedById: userId, approvedAt: new Date() },
  });

  return { success: true, status: "APPROVED" };
}

export async function rejectPost(
  postId: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<ApprovalResult> {
  const ctx = await resolveContext(postId, userId, isGlobalAdmin);
  if (!ctx.ok) return { success: false, code: ctx.code };

  if (!ctx.isOwner) return { success: false, code: "FORBIDDEN" };

  if (ctx.postStatus !== "pending_approval") {
    return {
      success: false,
      code: "INVALID_TRANSITION",
      message: `Only pending approval posts can be rejected. Current status: ${ctx.postStatus.toUpperCase()}.`,
    };
  }

  await prisma.post.update({
    where: { id: postId },
    data: { status: "rejected", rejectedById: userId, rejectedAt: new Date() },
  });

  return { success: true, status: "REJECTED" };
}
