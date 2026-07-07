import { createHash } from "crypto";
import { prisma } from "@/lib/db/client";

type VerifyEmailSuccess = { success: true };
type VerifyEmailFailure = { success: false; code: "INVALID_TOKEN" | "TOKEN_EXPIRED" };

export type VerifyEmailResult = VerifyEmailSuccess | VerifyEmailFailure;

export async function verifyEmail(rawToken: string): Promise<VerifyEmailResult> {
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");

  const record = await prisma.emailVerificationToken.findUnique({
    where: { tokenHash },
    select: { id: true, userId: true, expiresAt: true },
  });

  if (!record) return { success: false, code: "INVALID_TOKEN" };

  if (record.expiresAt < new Date()) {
    await prisma.emailVerificationToken.delete({ where: { id: record.id } });
    return { success: false, code: "TOKEN_EXPIRED" };
  }

  await prisma.$transaction([
    prisma.user.update({ where: { id: record.userId }, data: { emailVerified: true } }),
    prisma.emailVerificationToken.delete({ where: { id: record.id } }),
  ]);

  return { success: true };
}
