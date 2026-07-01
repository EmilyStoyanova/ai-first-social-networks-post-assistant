import { auth } from "@/lib/auth";
import { handleBufferCallback } from "@/lib/services/buffer/handle-buffer-callback.service";

interface Context {
  params: Promise<{ slug: string }>;
}

export async function GET(request: Request, context: Context) {
  const { slug } = await context.params;
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  const session = await auth();
  if (!session) {
    return Response.redirect(new URL(`/companies/${slug}?buffer=error`, request.url), 302);
  }

  const result = await handleBufferCallback(
    slug,
    code,
    state,
    session.user.id,
    session.user.isGlobalAdmin
  );

  if (!result.success) {
    return Response.redirect(new URL(`/companies/${slug}?buffer=error`, request.url), 302);
  }

  return Response.redirect(new URL(`/companies/${slug}?buffer=connected`, request.url), 302);
}
