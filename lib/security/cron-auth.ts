import { timingSafeEqual } from "crypto";

export type CronAuthResult = "authorized" | "unauthorized" | "not_configured";

function safeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Authorizes internal (non-session) requests against CRON_SECRET.
 * Accepts either `Authorization: Bearer <secret>` (sent automatically by
 * Vercel Cron when the CRON_SECRET env var is set) or an `x-api-key` header
 * (manual invocation / external schedulers).
 */
export function verifyCronRequest(request: Request): CronAuthResult {
  const secret = process.env.CRON_SECRET;
  if (!secret) return "not_configured";

  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ") && safeEquals(authHeader.slice(7), secret)) {
    return "authorized";
  }

  const apiKey = request.headers.get("x-api-key");
  if (apiKey && safeEquals(apiKey, secret)) return "authorized";

  return "unauthorized";
}
