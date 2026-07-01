import { createHmac, randomBytes, timingSafeEqual } from "crypto";

interface StatePayload {
  slug: string;
  userId: string;
  nonce: string;
}

function getSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET environment variable is not set.");
  return secret;
}

/**
 * Creates a HMAC-SHA256-signed OAuth state token.
 * Format: base64url(payload).hmac_hex
 */
export function createOAuthState(slug: string, userId: string): string {
  const payload: StatePayload = { slug, userId, nonce: randomBytes(16).toString("hex") };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", getSecret()).update(encoded).digest("hex");
  return `${encoded}.${sig}`;
}

/**
 * Verifies a state token and returns the decoded payload, or null if invalid.
 * Uses constant-time comparison to prevent timing attacks.
 */
export function verifyOAuthState(state: string): StatePayload | null {
  const dot = state.lastIndexOf(".");
  if (dot === -1) return null;

  const encoded = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expectedSig = createHmac("sha256", getSecret()).update(encoded).digest("hex");

  const sigBuf = Buffer.from(sig, "utf8");
  const expectedBuf = Buffer.from(expectedSig, "utf8");
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expectedBuf)) return null;

  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as StatePayload;
  } catch {
    return null;
  }
}
