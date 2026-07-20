import { prisma } from "@/lib/db/client";
import { decrypt } from "@/lib/security/encryption";
import { BufferAnalyticsClient } from "./buffer-analytics-client";
import { AnalyticsNoKeyError } from "./buffer-analytics-errors";

/**
 * Resolves a company's analytics client from its stored Personal API Key.
 *
 * Mirrors getBufferClient(), with one deliberate difference: there is no refresh
 * path. A Personal API Key does not expire — it is revoked or it is not — so the
 * only failure mode is rejection, handled by the caller.
 *
 * Decryption happens here and nowhere else; the plaintext key never leaves this
 * layer and is never returned to a client.
 */
export async function getBufferAnalyticsClient(companyId: string): Promise<BufferAnalyticsClient> {
  const connection = await prisma.bufferConnection.findUnique({
    where: { companyId },
    select: { analyticsKeyEnc: true },
  });

  if (!connection?.analyticsKeyEnc) throw new AnalyticsNoKeyError();

  return new BufferAnalyticsClient(decrypt(connection.analyticsKeyEnc));
}

/** Whether analytics are configured, without decrypting anything. */
export async function hasAnalyticsKey(companyId: string): Promise<boolean> {
  const connection = await prisma.bufferConnection.findUnique({
    where: { companyId },
    select: { analyticsKeyEnc: true },
  });
  return Boolean(connection?.analyticsKeyEnc);
}
