const BUFFER_AUTH_URL = "https://bufferapp.com/oauth2/authorize";
const BUFFER_TOKEN_URL = "https://api.bufferapp.com/1/oauth2/token.json";
const BUFFER_USER_URL = "https://api.bufferapp.com/1/user.json";

export function getBufferAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
  });
  return `${BUFFER_AUTH_URL}?${params.toString()}`;
}

export async function exchangeCodeForTokens(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<{ accessToken: string }> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code,
    grant_type: "authorization_code",
  });

  const res = await fetch(BUFFER_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`Buffer token exchange failed with status ${res.status}.`);
  }

  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("Buffer did not return an access token.");
  return { accessToken: data.access_token };
}

export async function getBufferUserId(accessToken: string): Promise<string> {
  const params = new URLSearchParams({ access_token: accessToken });
  const res = await fetch(`${BUFFER_USER_URL}?${params.toString()}`);

  if (!res.ok) {
    throw new Error(`Buffer user lookup failed with status ${res.status}.`);
  }

  const data = (await res.json()) as { id?: string };
  if (!data.id) throw new Error("Buffer did not return a user ID.");
  return data.id;
}
