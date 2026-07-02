import { prisma } from "@/lib/db/client";

const EDITABLE_STATUSES = new Set(["draft", "pending_approval", "rejected"]);

export interface PostVersionItem {
  id: string;
  version: number;
  content: string;
  changedBy: string;
  changedByName: string | null;
  createdAt: string;
}

export interface EditPostInput {
  content: string;
  hashtags: string[];
}

export type UpdatePostResult =
  | { success: true }
  | {
      success: false;
      code: "NOT_FOUND" | "FORBIDDEN" | "POST_LOCKED" | "VALIDATION_ERROR";
      message?: string;
    };

export type GetVersionsResult =
  | { success: true; versions: PostVersionItem[] }
  | { success: false; code: "NOT_FOUND" | "FORBIDDEN" };

export type RestoreVersionResult =
  | { success: true }
  | {
      success: false;
      code: "NOT_FOUND" | "FORBIDDEN" | "VERSION_NOT_FOUND" | "POST_LOCKED";
      message?: string;
    };

async function resolvePostAccess(
  postId: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<
  | { ok: false; code: "NOT_FOUND" }
  | {
      ok: true;
      post: { companyId: string; status: string; content: string; hashtags: string[] };
      isOwner: boolean;
    }
> {
  const post = await prisma.post.findUnique({
    where: { id: postId },
    select: { companyId: true, status: true, content: true, hashtags: true },
  });
  if (!post) return { ok: false, code: "NOT_FOUND" };

  if (isGlobalAdmin) {
    return { ok: true, post, isOwner: true };
  }

  const membership = await prisma.companyMember.findFirst({
    where: { companyId: post.companyId, userId },
    select: { role: true },
  });
  if (!membership) return { ok: false, code: "NOT_FOUND" };

  return { ok: true, post, isOwner: membership.role === "owner" };
}

async function nextVersionNumber(postId: string): Promise<number> {
  const last = await prisma.postVersion.findFirst({
    where: { postId },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  return (last?.version ?? 0) + 1;
}

export async function updatePost(
  postId: string,
  userId: string,
  isGlobalAdmin: boolean,
  input: EditPostInput
): Promise<UpdatePostResult> {
  if (!input.content.trim()) {
    return { success: false, code: "VALIDATION_ERROR", message: "Content cannot be empty." };
  }

  const ctx = await resolvePostAccess(postId, userId, isGlobalAdmin);
  if (!ctx.ok) return { success: false, code: ctx.code };

  if (!EDITABLE_STATUSES.has(ctx.post.status)) {
    return {
      success: false,
      code: "POST_LOCKED",
      message: `Posts with status ${ctx.post.status.toUpperCase()} cannot be edited.`,
    };
  }

  const version = await nextVersionNumber(postId);

  await prisma.postVersion.create({
    data: { postId, version, content: ctx.post.content, changedBy: userId },
  });

  await prisma.post.update({
    where: { id: postId },
    data: {
      content: input.content.trim(),
      hashtags: input.hashtags.map((h) => h.trim()).filter(Boolean),
    },
  });

  return { success: true };
}

export async function getPostVersions(
  postId: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<GetVersionsResult> {
  const ctx = await resolvePostAccess(postId, userId, isGlobalAdmin);
  if (!ctx.ok) return { success: false, code: ctx.code };

  const rows = await prisma.postVersion.findMany({
    where: { postId },
    orderBy: { version: "desc" },
    select: {
      id: true,
      version: true,
      content: true,
      changedBy: true,
      changer: { select: { name: true } },
      createdAt: true,
    },
  });

  return {
    success: true,
    versions: rows.map((r) => ({
      id: r.id,
      version: r.version,
      content: r.content,
      changedBy: r.changedBy,
      changedByName: r.changer.name ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

export async function restoreVersion(
  postId: string,
  versionId: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<RestoreVersionResult> {
  const ctx = await resolvePostAccess(postId, userId, isGlobalAdmin);
  if (!ctx.ok) return { success: false, code: ctx.code };

  if (!ctx.isOwner) return { success: false, code: "FORBIDDEN" };

  if (!EDITABLE_STATUSES.has(ctx.post.status)) {
    return {
      success: false,
      code: "POST_LOCKED",
      message: `Posts with status ${ctx.post.status.toUpperCase()} cannot be edited.`,
    };
  }

  const ver = await prisma.postVersion.findFirst({
    where: { id: versionId, postId },
    select: { content: true },
  });
  if (!ver) return { success: false, code: "VERSION_NOT_FOUND" };

  const version = await nextVersionNumber(postId);

  await prisma.postVersion.create({
    data: { postId, version, content: ctx.post.content, changedBy: userId },
  });

  await prisma.post.update({
    where: { id: postId },
    data: { content: ver.content },
  });

  return { success: true };
}
