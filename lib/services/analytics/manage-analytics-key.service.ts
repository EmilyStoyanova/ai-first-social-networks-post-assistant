import { prisma } from "@/lib/db/client";
import { encrypt } from "@/lib/security/encryption";
import { BufferAnalyticsClient } from "@/lib/buffer/buffer-analytics-client";
import {
  AnalyticsKeyInvalidError,
  AnalyticsRateLimitError,
  AnalyticsScopeError,
} from "@/lib/buffer/buffer-analytics-errors";
import { checkBufferAccess } from "@/lib/services/buffer/_access";
import { createAuditLog, AUDIT_ACTIONS } from "@/lib/services/audit/audit-log.service";

/**
 * Owner-facing management of a company's Buffer Personal API Key (v2-7).
 *
 * The key is analytics-read only. Publishing continues to use the OAuth
 * connection and is untouched by anything in this file.
 *
 * Two invariants hold everywhere below:
 *   • The raw key is never returned to a caller. Only `last4` ever leaves.
 *   • A key is never stored before Buffer has accepted it (see setAnalyticsKey).
 */

export interface AnalyticsKeyStatus {
  /** False when Buffer itself is not connected — analytics cannot be configured. */
  bufferConnected: boolean;
  configured: boolean;
  /** Last 4 characters, for "••••abcd" display. Null when not configured. */
  last4: string | null;
  addedAt: Date | null;
  /** Last time a metrics call with this key succeeded. Null if never. */
  lastValidAt: Date | null;
}

type Failure =
  | { success: false; code: "NOT_FOUND" | "FORBIDDEN" }
  | { success: false; code: "NO_CONNECTION"; message: string }
  | {
      success: false;
      code: "INVALID_KEY" | "INSUFFICIENT_SCOPE" | "BUFFER_UNAVAILABLE";
      message: string;
    };

export type SetAnalyticsKeyResult =
  { success: true; data: AnalyticsKeyStatus & { organizationName: string } } | Failure;

export type DeleteAnalyticsKeyResult = { success: true } | Failure;

export type GetAnalyticsKeyStatusResult =
  { success: true; data: AnalyticsKeyStatus } | { success: false; code: "NOT_FOUND" | "FORBIDDEN" };

/** Buffer keys are opaque; only obvious junk is rejected before a network call. */
const MIN_KEY_LENGTH = 16;

function statusFrom(connection: {
  analyticsKeyEnc: string | null;
  analyticsKeyLast4: string | null;
  analyticsKeyAddedAt: Date | null;
  analyticsKeyLastValidAt: Date | null;
}): AnalyticsKeyStatus {
  return {
    bufferConnected: true,
    configured: Boolean(connection.analyticsKeyEnc),
    last4: connection.analyticsKeyLast4,
    addedAt: connection.analyticsKeyAddedAt,
    lastValidAt: connection.analyticsKeyLastValidAt,
  };
}

/**
 * Validates a Personal API Key against Buffer and stores it only if it works.
 *
 * The connection test is not advisory — it gates the write. A key that
 * authenticates but lacks `insights:read` is rejected too, because it would save
 * cleanly and then fail on every subsequent sync, which reads to an owner as
 * "analytics are broken" rather than "this key is wrong".
 */
export async function setAnalyticsKey(
  slug: string,
  rawKey: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<SetAnalyticsKeyResult> {
  const access = await checkBufferAccess(slug, userId, isGlobalAdmin);
  if (!access.ok) return { success: false, code: access.error };

  const key = rawKey.trim();
  if (key.length < MIN_KEY_LENGTH) {
    return {
      success: false,
      code: "INVALID_KEY",
      message: "That does not look like a Buffer Personal API Key.",
    };
  }

  const connection = await prisma.bufferConnection.findUnique({
    where: { companyId: access.companyId },
    select: { id: true },
  });

  // Analytics read metrics for posts published through Buffer, so a Buffer
  // connection is a precondition rather than an independent setting.
  if (!connection) {
    return {
      success: false,
      code: "NO_CONNECTION",
      message: "Connect Buffer before adding an analytics key.",
    };
  }

  // ── Test before storing ────────────────────────────────────────────────────
  let organizationName: string;
  try {
    organizationName = (await new BufferAnalyticsClient(key).validateKey()).organizationName;
  } catch (err) {
    if (err instanceof AnalyticsScopeError) {
      return {
        success: false,
        code: "INSUFFICIENT_SCOPE",
        message: "This key cannot read analytics. Check that it is a Personal API Key.",
      };
    }
    if (err instanceof AnalyticsKeyInvalidError) {
      return { success: false, code: "INVALID_KEY", message: "Buffer rejected this key." };
    }
    if (err instanceof AnalyticsRateLimitError) {
      return {
        success: false,
        code: "BUFFER_UNAVAILABLE",
        message: "Could not reach Buffer to verify the key. Try again shortly.",
      };
    }
    throw err;
  }

  const now = new Date();
  const updated = await prisma.bufferConnection.update({
    where: { id: connection.id },
    data: {
      analyticsKeyEnc: encrypt(key),
      analyticsKeyLast4: key.slice(-4),
      analyticsKeyAddedAt: now,
      // The validation call above WAS a successful metrics read, so the key is
      // known-good as of now.
      analyticsKeyLastValidAt: now,
    },
    select: {
      analyticsKeyEnc: true,
      analyticsKeyLast4: true,
      analyticsKeyAddedAt: true,
      analyticsKeyLastValidAt: true,
    },
  });

  await createAuditLog({
    companyId: access.companyId,
    userId,
    action: AUDIT_ACTIONS.ANALYTICS_KEY_SET,
    entityType: "buffer_connection",
    entityId: connection.id,
    // Deliberately records only the organization and last4 — never the key.
    metadata: { organizationName, last4: key.slice(-4) },
  });

  return { success: true, data: { ...statusFrom(updated), organizationName } };
}

/** Removes the key and disables analytics. Stored metrics are left intact. */
export async function deleteAnalyticsKey(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<DeleteAnalyticsKeyResult> {
  const access = await checkBufferAccess(slug, userId, isGlobalAdmin);
  if (!access.ok) return { success: false, code: access.error };

  const connection = await prisma.bufferConnection.findUnique({
    where: { companyId: access.companyId },
    select: { id: true },
  });
  if (!connection) {
    return { success: false, code: "NO_CONNECTION", message: "Buffer is not connected." };
  }

  await prisma.bufferConnection.update({
    where: { id: connection.id },
    data: {
      analyticsKeyEnc: null,
      analyticsKeyLast4: null,
      analyticsKeyAddedAt: null,
      analyticsKeyLastValidAt: null,
    },
  });

  await createAuditLog({
    companyId: access.companyId,
    userId,
    action: AUDIT_ACTIONS.ANALYTICS_KEY_REMOVED,
    entityType: "buffer_connection",
    entityId: connection.id,
  });

  return { success: true };
}

/** Read-only status for the settings UI. Never touches the encrypted value. */
export async function getAnalyticsKeyStatus(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<GetAnalyticsKeyStatusResult> {
  const access = await checkBufferAccess(slug, userId, isGlobalAdmin);
  if (!access.ok) return { success: false, code: access.error };

  const connection = await prisma.bufferConnection.findUnique({
    where: { companyId: access.companyId },
    select: {
      analyticsKeyEnc: true,
      analyticsKeyLast4: true,
      analyticsKeyAddedAt: true,
      analyticsKeyLastValidAt: true,
    },
  });

  if (!connection) {
    return {
      success: true,
      data: {
        bufferConnected: false,
        configured: false,
        last4: null,
        addedAt: null,
        lastValidAt: null,
      },
    };
  }

  return { success: true, data: statusFrom(connection) };
}
