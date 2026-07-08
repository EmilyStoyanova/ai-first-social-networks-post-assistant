import { prisma } from "@/lib/db/client";
import { getBufferClient } from "@/lib/buffer/buffer-provider";
import { BufferNoConnectionError, BufferTokenExpiredError } from "@/lib/buffer/buffer-errors";

export type ResolvePostUrlResult =
  | { success: true; publishedPostUrl: string | null }
  | { success: false; code: "NOT_FOUND" | "FORBIDDEN" | "NO_CONNECTION" | "TOKEN_EXPIRED" };

export async function resolvePostUrl(
  postId: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<ResolvePostUrlResult> {
  const post = await prisma.post.findUnique({
    where: { id: postId },
    select: {
      companyId: true,
      status: true,
      bufferUpdateId: true,
      publishedPostUrl: true,
    },
  });
  if (!post) return { success: false, code: "NOT_FOUND" };

  if (!isGlobalAdmin) {
    const membership = await prisma.companyMember.findFirst({
      where: { companyId: post.companyId, userId },
      select: { companyId: true },
    });
    if (!membership) return { success: false, code: "NOT_FOUND" };
  }

  // Already resolved — return immediately without hitting Buffer.
  if (post.publishedPostUrl) {
    return { success: true, publishedPostUrl: post.publishedPostUrl };
  }

  // No Buffer post ID means we can't look it up.
  if (!post.bufferUpdateId) {
    return { success: true, publishedPostUrl: null };
  }

  let client: Awaited<ReturnType<typeof getBufferClient>>;
  try {
    client = await getBufferClient(post.companyId);
  } catch (err) {
    if (err instanceof BufferNoConnectionError) return { success: false, code: "NO_CONNECTION" };
    if (err instanceof BufferTokenExpiredError) return { success: false, code: "TOKEN_EXPIRED" };
    throw err;
  }

  let url: string | null = null;
  try {
    url = await client.getPostLink(post.bufferUpdateId);
  } catch {
    // Non-fatal: return null, don't persist.
    return { success: true, publishedPostUrl: null };
  }

  if (url) {
    await prisma.post.update({
      where: { id: postId },
      data: { publishedPostUrl: url },
    });
  }

  return { success: true, publishedPostUrl: url };
}
