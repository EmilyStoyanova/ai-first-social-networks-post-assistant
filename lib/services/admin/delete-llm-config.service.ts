import { prisma } from "@/lib/db/client";

export type DeleteLlmConfigResult =
  { success: true } | { success: false; code: "FORBIDDEN" | "NOT_FOUND" | "CANNOT_DELETE_ACTIVE" };

export async function deleteLlmConfig(
  isGlobalAdmin: boolean,
  id: string
): Promise<DeleteLlmConfigResult> {
  if (!isGlobalAdmin) return { success: false, code: "FORBIDDEN" };

  const config = await prisma.llmConfig.findUnique({
    where: { id },
    select: { id: true, isActive: true },
  });
  if (!config) return { success: false, code: "NOT_FOUND" };

  if (config.isActive) return { success: false, code: "CANNOT_DELETE_ACTIVE" };

  await prisma.llmConfig.delete({ where: { id } });
  return { success: true };
}
