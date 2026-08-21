import { prisma } from "@/lib/db/client";
import { createAuditLog, AUDIT_ACTIONS } from "@/lib/services/audit/audit-log.service";

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

/**
 * A successful edit reports what was WRITTEN, not what was asked for.
 *
 * The two differ: content is trimmed and hashtags are trimmed and emptied out
 * below, so a client that echoed its own request back into the UI would show a
 * value the database does not hold. The card seeds its visible text from this,
 * which is why it is part of the result rather than something the caller has to
 * re-fetch.
 */
export type UpdatePostResult =
  | { success: true; content: string; hashtags: string[] }
  | {
      success: false;
      code: "NOT_FOUND" | "FORBIDDEN" | "POST_LOCKED" | "VALIDATION_ERROR";
      message?: string;
    };

// ── Injectable surface ──────────────────────────────────────────────────────
// The narrow slice of Prisma `updatePost` touches, so the edit rules are
// provable without a database. Same pattern, and same reason, as ApprovalDb in
// post-approval.service.ts: the real client satisfies this shape, and tests
// inject a fake that captures writes.

export interface PostEditorDb {
  post: {
    findUnique: (args: {
      where: { id: string };
      select: { companyId: true; status: true; content: true; hashtags: true };
    }) => Promise<{
      companyId: string;
      status: string;
      content: string;
      hashtags: string[];
    } | null>;
    update: (args: {
      where: { id: string };
      data: { content?: string; hashtags?: string[] };
    }) => Promise<unknown>;
  };
  postVersion: {
    findFirst: (args: {
      where: { postId: string };
      orderBy: { version: "desc" };
      select: { version: true };
    }) => Promise<{ version: number } | null>;
    create: (args: {
      data: { postId: string; version: number; content: string; changedBy: string };
    }) => Promise<unknown>;
  };
  companyMember: {
    findFirst: (args: {
      where: { companyId: string; userId: string };
      select: { role: true };
    }) => Promise<{ role: string } | null>;
  };
}

export interface PostEditorDeps {
  db?: PostEditorDb;
  auditLog?: typeof createAuditLog;
}

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
  db: PostEditorDb,
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
  const post = await db.post.findUnique({
    where: { id: postId },
    select: { companyId: true, status: true, content: true, hashtags: true },
  });
  if (!post) return { ok: false, code: "NOT_FOUND" };

  if (isGlobalAdmin) {
    return { ok: true, post, isOwner: true };
  }

  const membership = await db.companyMember.findFirst({
    where: { companyId: post.companyId, userId },
    select: { role: true },
  });
  if (!membership) return { ok: false, code: "NOT_FOUND" };

  return { ok: true, post, isOwner: membership.role === "owner" };
}

async function nextVersionNumber(db: PostEditorDb, postId: string): Promise<number> {
  const last = await db.postVersion.findFirst({
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
  input: EditPostInput,
  deps: PostEditorDeps = {}
): Promise<UpdatePostResult> {
  const db: PostEditorDb = deps.db ?? prisma;
  const writeAuditLog = deps.auditLog ?? createAuditLog;

  if (!input.content.trim()) {
    return { success: false, code: "VALIDATION_ERROR", message: "Content cannot be empty." };
  }

  const ctx = await resolvePostAccess(db, postId, userId, isGlobalAdmin);
  if (!ctx.ok) return { success: false, code: ctx.code };

  if (!EDITABLE_STATUSES.has(ctx.post.status)) {
    return {
      success: false,
      code: "POST_LOCKED",
      message: `Posts with status ${ctx.post.status.toUpperCase()} cannot be edited.`,
    };
  }

  const newContent = input.content.trim();
  const newHashtags = input.hashtags.map((h) => h.trim()).filter(Boolean);

  const changedFields: string[] = [];
  if (ctx.post.content !== newContent) changedFields.push("content");
  if (JSON.stringify([...ctx.post.hashtags].sort()) !== JSON.stringify([...newHashtags].sort())) {
    changedFields.push("hashtags");
  }

  const version = await nextVersionNumber(db, postId);

  await db.postVersion.create({
    data: { postId, version, content: ctx.post.content, changedBy: userId },
  });

  await db.post.update({
    where: { id: postId },
    data: { content: newContent, hashtags: newHashtags },
  });

  await writeAuditLog({
    companyId: ctx.post.companyId,
    userId,
    action: AUDIT_ACTIONS.POST_EDITED,
    entityType: "post",
    entityId: postId,
    metadata: { changedFields },
  });

  return { success: true, content: newContent, hashtags: newHashtags };
}

export async function getPostVersions(
  postId: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<GetVersionsResult> {
  const ctx = await resolvePostAccess(prisma, postId, userId, isGlobalAdmin);
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
  const ctx = await resolvePostAccess(prisma, postId, userId, isGlobalAdmin);
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

  const version = await nextVersionNumber(prisma, postId);

  await prisma.postVersion.create({
    data: { postId, version, content: ctx.post.content, changedBy: userId },
  });

  await prisma.post.update({
    where: { id: postId },
    data: { content: ver.content },
  });

  await createAuditLog({
    companyId: ctx.post.companyId,
    userId,
    action: AUDIT_ACTIONS.POST_VERSION_RESTORED,
    entityType: "post",
    entityId: postId,
    metadata: { versionId },
  });

  return { success: true };
}
