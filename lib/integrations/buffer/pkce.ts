import { createHash, randomBytes } from "crypto";

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/**
 * Generates a PKCE code verifier and its S256 challenge (RFC 7636).
 * Buffer requires PKCE for all OAuth clients.
 */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Cookie carrying the PKCE verifier between the authorize redirect and the callback. */
export const PKCE_COOKIE_NAME = "buffer_pkce_verifier";
export const PKCE_COOKIE_PATH = "/api/v1/buffer/callback";
export const PKCE_COOKIE_MAX_AGE = 600;
