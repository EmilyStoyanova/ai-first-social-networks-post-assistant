import { prisma } from "@/lib/db/client";
import { exchangeCodeForTokens, getBufferUserId } from "@/lib/integrations/buffer/client";
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
  currentUserId: string,
  isGlobalAdmin: boolean
): Promise<HandleBufferCallbackResult> {
  if (!code || !state) return { success: false, slug: null, code: "INVALID_STATE" };

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

  let accessToken: string;
  let bufferUserId: string;

  try {
    const tokens = await exchangeCodeForTokens(
      code,
      config.clientId,
      config.clientSecret,
      config.redirectUri
    );
    accessToken = tokens.accessToken;
    bufferUserId = await getBufferUserId(accessToken);
  } catch {
    return { success: false, slug, code: "EXCHANGE_FAILED" };
  }

  // Token encrypted before storage — never stored in plain text.
  const accessTokenEnc = encrypt(accessToken);

  await prisma.bufferConnection.upsert({
    where: { companyId: access.companyId },
    create: { companyId: access.companyId, bufferUserId, accessTokenEnc },
    update: { bufferUserId, accessTokenEnc },
  });

  return { success: true, slug };
}
