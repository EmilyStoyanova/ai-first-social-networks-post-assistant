import { prisma } from "@/lib/db/client";

export interface BufferConnectionStatus {
  connected: boolean;
  bufferUserId: string | null;
  connectedAt: Date | null;
}

export async function getBufferConnection(companyId: string): Promise<BufferConnectionStatus> {
  const connection = await prisma.bufferConnection.findUnique({
    where: { companyId },
    select: { bufferUserId: true, updatedAt: true },
  });

  if (!connection) {
    return { connected: false, bufferUserId: null, connectedAt: null };
  }

  return {
    connected: true,
    bufferUserId: connection.bufferUserId,
    connectedAt: connection.updatedAt,
  };
}
