import { createHash, randomBytes } from "crypto";
import { Resend } from "resend";
import { prisma } from "@/lib/db/client";

const EXPIRY_HOURS = 24;
const FROM = "contact@edamame.digital";

function getResend(): Resend {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY environment variable is not set.");
  return new Resend(key);
}

function getBaseUrl(): string {
  if (process.env.NEXTAUTH_URL) return process.env.NEXTAUTH_URL.replace(/\/$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

function buildEmailHtml(verifyUrl: string, lang: string): string {
  const isBg = lang === "bg";
  const subject = isBg ? "Потвърди имейл адреса си" : "Verify your email address";
  const greeting = isBg ? "Здравей," : "Hello,";
  const body = isBg
    ? "Благодарим ти за регистрацията. Натисни бутона по-долу, за да потвърдиш имейл адреса си и активираш акаунта."
    : "Thank you for registering. Click the button below to verify your email address and activate your account.";
  const cta = isBg ? "Потвърди имейл" : "Verify email";
  const expiry = isBg ? "Връзката е валидна 24 часа." : "This link expires in 24 hours.";
  const ignore = isBg
    ? "Ако не си се регистрирал(а), игнорирай този имейл."
    : "If you did not register, you can safely ignore this email.";

  return `<!DOCTYPE html>
<html lang="${lang}">
<head><meta charset="UTF-8"><title>${subject}</title></head>
<body style="font-family:sans-serif;max-width:520px;margin:40px auto;padding:0 24px;color:#111">
  <p>${greeting}</p>
  <p>${body}</p>
  <p style="margin:32px 0">
    <a href="${verifyUrl}" style="background:#111;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">${cta}</a>
  </p>
  <p style="font-size:13px;color:#666">${expiry}</p>
  <p style="font-size:13px;color:#666">${ignore}</p>
</body>
</html>`;
}

export async function sendVerificationEmail(
  userId: string,
  email: string,
  lang: string
): Promise<void> {
  // Delete any existing tokens for this user before creating a new one
  await prisma.emailVerificationToken.deleteMany({ where: { userId } });

  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const expiresAt = new Date(Date.now() + EXPIRY_HOURS * 60 * 60 * 1000);

  await prisma.emailVerificationToken.create({
    data: { userId, tokenHash, expiresAt },
  });

  const verifyUrl = `${getBaseUrl()}/api/v1/auth/verify-email?token=${rawToken}`;
  const isBg = lang === "bg";
  const subject = isBg ? "Потвърди имейл адреса си" : "Verify your email address";

  await getResend().emails.send({
    from: FROM,
    to: email,
    subject,
    html: buildEmailHtml(verifyUrl, lang),
  });
}
