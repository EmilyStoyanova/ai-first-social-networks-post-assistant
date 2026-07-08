import { prisma } from "@/lib/db/client";

export interface BufferConnectionStatus {
  connected: boolean;
  bufferUserId: string | null;
  connectedAt: Date | null;
  lastProfileSyncAt: Date | null;
}

export async function getBufferConnection(companyId: string): Promise<BufferConnectionStatus> {
  const connection = await prisma.bufferConnection.findUnique({
    where: { companyId },
    select: { bufferUserId: true, updatedAt: true, lastProfileSyncAt: true },
  });

  if (!connection) {
    return { connected: false, bufferUserId: null, connectedAt: null, lastProfileSyncAt: null };
  }

  return {
    connected: true,
    bufferUserId: connection.bufferUserId,
    connectedAt: connection.updatedAt,
    lastProfileSyncAt: connection.lastProfileSyncAt,
  };
}
