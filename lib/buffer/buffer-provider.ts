import { prisma } from "@/lib/db/client";
import { refreshBufferTokens } from "@/lib/integrations/buffer/client";
import { decrypt, encrypt } from "@/lib/security/encryption";
import { BufferClient } from "./buffer-client";
import { BufferNoConnectionError, BufferTokenExpiredError } from "./buffer-errors";

// Refresh slightly before actual expiry so an in-flight request never races it.
const EXPIRY_LEEWAY_MS = 60_000;

/** Returns a ready-to-use BufferClient, refreshing the access token if expired. */
export async function getBufferClient(companyId: string): Promise<BufferClient> {
  const connection = await prisma.bufferConnection.findUnique({
    where: { companyId },
    select: {
      id: true,
      accessTokenEnc: true,
      refreshTokenEnc: true,
      tokenExpiresAt: true,
    },
  });

  if (!connection) throw new BufferNoConnectionError();

  const isExpired =
    connection.tokenExpiresAt !== null &&
    connection.tokenExpiresAt.getTime() < Date.now() + EXPIRY_LEEWAY_MS;

  if (isExpired && connection.refreshTokenEnc) {
    const clientId = process.env.BUFFER_CLIENT_ID;
    const clientSecret = process.env.BUFFER_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new BufferTokenExpiredError();

    let tokens: Awaited<ReturnType<typeof refreshBufferTokens>>;
    try {
      tokens = await refreshBufferTokens(
        decrypt(connection.refreshTokenEnc),
        clientId,
        clientSecret
      );
    } catch {
      // Refresh tokens are single-use; a failed refresh means the user must reconnect.
      throw new BufferTokenExpiredError();
    }

    await prisma.bufferConnection.update({
      where: { id: connection.id },
      data: {
        accessTokenEnc: encrypt(tokens.accessToken),
        refreshTokenEnc: tokens.refreshToken
          ? encrypt(tokens.refreshToken)
          : connection.refreshTokenEnc,
        tokenExpiresAt: tokens.expiresAt,
      },
    });

    return new BufferClient(tokens.accessToken);
  }

  // Decryption happens here — token never leaves this layer
  const accessToken = decrypt(connection.accessTokenEnc);
  return new BufferClient(accessToken);
}
