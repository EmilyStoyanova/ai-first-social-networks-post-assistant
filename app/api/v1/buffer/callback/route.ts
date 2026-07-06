import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { PKCE_COOKIE_NAME, PKCE_COOKIE_PATH } from "@/lib/integrations/buffer/pkce";
import { handleBufferCallback } from "@/lib/services/buffer/handle-buffer-callback.service";

function redirectClearingPkce(destination: URL): NextResponse {
  const response = NextResponse.redirect(destination, 302);
  response.cookies.set(PKCE_COOKIE_NAME, "", { path: PKCE_COOKIE_PATH, maxAge: 0 });
  return response;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  const session = await auth();
  if (!session) {
    return redirectClearingPkce(new URL("/dashboard?buffer=error", request.url));
  }

  const cookieStore = await cookies();
  const codeVerifier = cookieStore.get(PKCE_COOKIE_NAME)?.value ?? null;

  const result = await handleBufferCallback(
    code,
    state,
    codeVerifier,
    session.user.id,
    session.user.isGlobalAdmin
  );

  if (!result.success) {
    const destination = result.slug
      ? `/companies/${result.slug}?buffer=error`
      : "/dashboard?buffer=error";
    return redirectClearingPkce(new URL(destination, request.url));
  }

  return redirectClearingPkce(new URL(`/companies/${result.slug}?buffer=connected`, request.url));
}
