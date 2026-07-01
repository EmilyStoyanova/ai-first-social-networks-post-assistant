import { prisma } from "@/lib/db/client";
import { checkBufferAccess } from "./_access";

export type DisconnectBufferResult =
  { success: true } | { success: false; code: "NOT_FOUND" | "FORBIDDEN" };

export async function disconnectBuffer(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<DisconnectBufferResult> {
  const access = await checkBufferAccess(slug, userId, isGlobalAdmin);
  if (!access.ok) return { success: false, code: access.error };

  // deleteMany is idempotent — no error if no connection exists.
  await prisma.bufferConnection.deleteMany({ where: { companyId: access.companyId } });
  return { success: true };
}
