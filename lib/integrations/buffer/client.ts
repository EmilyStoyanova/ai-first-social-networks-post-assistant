// Buffer's current OAuth endpoints (the legacy bufferapp.com/oauth2 endpoints reject
// client IDs issued by the new developer portal with invalid_client).
const BUFFER_AUTH_URL = "https://auth.buffer.com/auth";
const BUFFER_TOKEN_URL = "https://auth.buffer.com/token";
const BUFFER_API_URL = "https://api.buffer.com";

// offline_access is required to receive a refresh token; access tokens are short-lived.
const BUFFER_SCOPES = "account:read posts:read posts:write offline_access";

export interface BufferTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
}

export function getBufferAuthUrl(
  clientId: string,
  redirectUri: string,
  state: string,
  codeChallenge: string
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: BUFFER_SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    prompt: "consent",
  });
  return `${BUFFER_AUTH_URL}?${params.toString()}`;
}

async function requestTokens(body: URLSearchParams): Promise<BufferTokens> {
  const res = await fetch(BUFFER_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`Buffer token request failed with status ${res.status}.`);
  }

  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!data.access_token) throw new Error("Buffer did not return an access token.");

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt:
      typeof data.expires_in === "number" ? new Date(Date.now() + data.expires_in * 1000) : null,
  };
}

export async function exchangeCodeForTokens(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  codeVerifier: string
): Promise<BufferTokens> {
  return requestTokens(
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    })
  );
}

/** Refresh tokens are single-use: always persist the newly returned refresh token. */
export async function refreshBufferTokens(
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<BufferTokens> {
  return requestTokens(
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    })
  );
}

export async function getBufferAccountId(accessToken: string): Promise<string> {
  const res = await fetch(BUFFER_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query: "query GetAccount { account { id } }" }),
  });

  if (!res.ok) {
    throw new Error(`Buffer account lookup failed with status ${res.status}.`);
  }

  const data = (await res.json()) as { data?: { account?: { id?: string } } };
  const id = data.data?.account?.id;
  if (!id) throw new Error("Buffer did not return an account ID.");
  return id;
}
