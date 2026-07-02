import { prisma } from "@/lib/db/client";
import { decrypt } from "@/lib/security/encryption";
import { BufferClient } from "./buffer-client";
import { BufferNoConnectionError } from "./buffer-errors";

/** Returns a ready-to-use BufferClient with the decrypted access token. */
export async function getBufferClient(companyId: string): Promise<BufferClient> {
  const connection = await prisma.bufferConnection.findUnique({
    where: { companyId },
    select: { accessTokenEnc: true },
  });

  if (!connection) throw new BufferNoConnectionError();

  // Decryption happens here — token never leaves this layer
  const accessToken = decrypt(connection.accessTokenEnc);
  return new BufferClient(accessToken);
}
