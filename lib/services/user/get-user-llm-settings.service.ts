import type { LlmProvider } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import {
  toAvailableLlm,
  type AvailableLlm,
} from "@/lib/services/company/get-available-llms.service";

/**
 * The data the personal "Preferred LLM" settings control needs: every active
 * provider (secret-scrubbed) plus the caller's EFFECTIVE preference — the stored
 * id only when it is still active, so a preference that has since been
 * deactivated/deleted transparently reads as "System default".
 */
export interface UserLlmSettings {
  llms: AvailableLlm[];
  preferredLlmConfigId: string | null;
}

export interface UserLlmSettingsDb {
  user: {
    findUnique: (args: {
      where: { id: string };
      select: { preferredLlmConfigId: true };
    }) => Promise<{ preferredLlmConfigId: string | null } | null>;
  };
  llmConfig: {
    findMany: (args: {
      where: { isActive: true };
      select: { id: true; provider: true; isDefault: true };
      orderBy: { createdAt: "asc" };
    }) => Promise<Array<{ id: string; provider: LlmProvider; isDefault: boolean }>>;
  };
}

export async function getUserLlmSettingsCore(
  userId: string,
  db: UserLlmSettingsDb
): Promise<UserLlmSettings> {
  const [user, rows] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { preferredLlmConfigId: true } }),
    db.llmConfig.findMany({
      where: { isActive: true },
      select: { id: true, provider: true, isDefault: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const stored = user?.preferredLlmConfigId ?? null;
  // Effective preference: only surface it when it still points at an active config.
  const effective = stored && rows.some((r) => r.id === stored) ? stored : null;

  return {
    llms: rows.map((row) => toAvailableLlm(row, effective)),
    preferredLlmConfigId: effective,
  };
}

// ─── Public API (uses real Prisma) ────────────────────────────────────────────

export async function getUserLlmSettings(userId: string): Promise<UserLlmSettings> {
  return getUserLlmSettingsCore(userId, prisma);
}
