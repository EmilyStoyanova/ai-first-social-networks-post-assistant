import { prisma } from "@/lib/db/client";

export type UpdatePreferredLlmResult =
  | { success: true; preferredLlmConfigId: string | null }
  | { success: false; code: "INVALID_CONFIG" };

export interface UpdatePreferredLlmDb {
  llmConfig: {
    findFirst: (args: {
      where: { id: string; isActive: true };
      select: { id: true };
    }) => Promise<{ id: string } | null>;
  };
  user: {
    update: (args: {
      where: { id: string };
      data: { preferredLlmConfigId: string | null };
      select: { preferredLlmConfigId: true };
    }) => Promise<{ preferredLlmConfigId: string | null }>;
  };
}

/**
 * Saves the current user's preferred LLM. `null` clears it ("use system
 * default"). A non-null id must reference an ACTIVE config — an inactive or
 * unknown id is rejected so a user can never pin an unusable model. Writes only
 * the calling user's row.
 */
export async function updatePreferredLlmCore(
  userId: string,
  llmConfigId: string | null,
  db: UpdatePreferredLlmDb
): Promise<UpdatePreferredLlmResult> {
  if (llmConfigId !== null) {
    const config = await db.llmConfig.findFirst({
      where: { id: llmConfigId, isActive: true },
      select: { id: true },
    });
    if (!config) return { success: false, code: "INVALID_CONFIG" };
  }

  const updated = await db.user.update({
    where: { id: userId },
    data: { preferredLlmConfigId: llmConfigId },
    select: { preferredLlmConfigId: true },
  });

  return { success: true, preferredLlmConfigId: updated.preferredLlmConfigId };
}

// ─── Public API (uses real Prisma) ────────────────────────────────────────────

export async function updatePreferredLlm(
  userId: string,
  llmConfigId: string | null
): Promise<UpdatePreferredLlmResult> {
  return updatePreferredLlmCore(userId, llmConfigId, prisma);
}
