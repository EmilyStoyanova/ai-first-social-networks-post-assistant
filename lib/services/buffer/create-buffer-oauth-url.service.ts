import { getBufferAuthUrl } from "@/lib/integrations/buffer/client";
import { createOAuthState } from "@/lib/integrations/buffer/state";
import { checkBufferAccess } from "./_access";

function getBufferConfig(): { clientId: string; clientSecret: string; redirectUri: string } | null {
  const clientId = process.env.BUFFER_CLIENT_ID;
  const clientSecret = process.env.BUFFER_CLIENT_SECRET;
  const redirectUri = process.env.BUFFER_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

export type CreateBufferOAuthUrlResult =
  | { success: true; url: string }
  | { success: false; code: "NOT_FOUND" | "FORBIDDEN" | "MISSING_CONFIG" };

export async function createBufferOAuthUrl(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<CreateBufferOAuthUrlResult> {
  const config = getBufferConfig();
  if (!config) return { success: false, code: "MISSING_CONFIG" };

  const access = await checkBufferAccess(slug, userId, isGlobalAdmin);
  if (!access.ok) return { success: false, code: access.error };

  const state = createOAuthState(slug, userId);
  const url = getBufferAuthUrl(config.clientId, config.redirectUri, state);
  return { success: true, url };
}
