import { prisma } from "@/lib/db/client";
import { sendVerificationEmail } from "./send-verification-email.service";

export async function resendVerificationEmail(email: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { email: email.trim().toLowerCase() },
    select: { id: true, email: true, emailVerified: true, preferredLang: true },
  });

  // Always return silently — never reveal whether the email exists or is verified
  if (!user || user.emailVerified) return;

  await sendVerificationEmail(user.id, user.email, user.preferredLang);
}
