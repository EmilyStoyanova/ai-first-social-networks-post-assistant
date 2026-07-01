import { auth } from "@/lib/auth";
import { handleBufferCallback } from "@/lib/services/buffer/handle-buffer-callback.service";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  const session = await auth();
  if (!session) {
    return Response.redirect(new URL("/dashboard?buffer=error", request.url), 302);
  }

  const result = await handleBufferCallback(
    code,
    state,
    session.user.id,
    session.user.isGlobalAdmin
  );

  if (!result.success) {
    const destination = result.slug
      ? `/companies/${result.slug}?buffer=error`
      : "/dashboard?buffer=error";
    return Response.redirect(new URL(destination, request.url), 302);
  }

  return Response.redirect(new URL(`/companies/${result.slug}?buffer=connected`, request.url), 302);
}
