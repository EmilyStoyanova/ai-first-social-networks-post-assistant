import { prisma } from "@/lib/db/client";
import { exchangeCodeForTokens, getBufferAccountId } from "@/lib/integrations/buffer/client";
import { verifyOAuthState } from "@/lib/integrations/buffer/state";
import { encrypt } from "@/lib/security/encryption";
import { checkBufferAccess } from "./_access";

function getBufferConfig(): { clientId: string; clientSecret: string; redirectUri: string } | null {
  const clientId = process.env.BUFFER_CLIENT_ID;
  const clientSecret = process.env.BUFFER_CLIENT_SECRET;
  const redirectUri = process.env.BUFFER_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

export type HandleBufferCallbackResult =
  | { success: true; slug: string }
  | {
      success: false;
      slug: string | null;
      code: "INVALID_STATE" | "NOT_FOUND" | "FORBIDDEN" | "EXCHANGE_FAILED" | "MISSING_CONFIG";
    };

export async function handleBufferCallback(
  code: string | null,
  state: string | null,
  codeVerifier: string | null,
  currentUserId: string,
  isGlobalAdmin: boolean
): Promise<HandleBufferCallbackResult> {
  if (!code || !state || !codeVerifier) {
    return { success: false, slug: null, code: "INVALID_STATE" };
  }

  const payload = verifyOAuthState(state);
  if (!payload) return { success: false, slug: null, code: "INVALID_STATE" };

  const { slug } = payload;

  // Verify the authenticated user matches the user who initiated the OAuth flow.
  if (payload.userId !== currentUserId) {
    return { success: false, slug, code: "INVALID_STATE" };
  }

  const config = getBufferConfig();
  if (!config) return { success: false, slug, code: "MISSING_CONFIG" };

  const access = await checkBufferAccess(slug, currentUserId, isGlobalAdmin);
  if (!access.ok) return { success: false, slug, code: access.error };

  let tokens: Awaited<ReturnType<typeof exchangeCodeForTokens>>;
  let bufferUserId: string;

  try {
    tokens = await exchangeCodeForTokens(
      code,
      config.clientId,
      config.clientSecret,
      config.redirectUri,
      codeVerifier
    );
    bufferUserId = await getBufferAccountId(tokens.accessToken);
  } catch {
    return { success: false, slug, code: "EXCHANGE_FAILED" };
  }

  // Tokens encrypted before storage — never stored in plain text.
  const accessTokenEnc = encrypt(tokens.accessToken);
  const refreshTokenEnc = tokens.refreshToken ? encrypt(tokens.refreshToken) : null;
  const tokenExpiresAt = tokens.expiresAt;

  await prisma.bufferConnection.upsert({
    where: { companyId: access.companyId },
    create: {
      companyId: access.companyId,
      bufferUserId,
      accessTokenEnc,
      refreshTokenEnc,
      tokenExpiresAt,
    },
    update: { bufferUserId, accessTokenEnc, refreshTokenEnc, tokenExpiresAt },
  });

  return { success: true, slug };
}
