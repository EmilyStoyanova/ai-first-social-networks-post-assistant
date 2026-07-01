import { auth } from "@/lib/auth";
import { createBufferOAuthUrl } from "@/lib/services/buffer/create-buffer-oauth-url.service";

interface Context {
  params: Promise<{ slug: string }>;
}

export async function GET(_req: Request, context: Context) {
  const session = await auth();
  if (!session) {
    return Response.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication required." } },
      { status: 401 }
    );
  }

  const { slug } = await context.params;
  const result = await createBufferOAuthUrl(slug, session.user.id, session.user.isGlobalAdmin);

  if (!result.success) {
    switch (result.code) {
      case "NOT_FOUND":
        return Response.json(
          { error: { code: "NOT_FOUND", message: "Company not found." } },
          { status: 404 }
        );
      case "FORBIDDEN":
        return Response.json(
          { error: { code: "FORBIDDEN", message: "Only company owners can connect Buffer." } },
          { status: 403 }
        );
      case "MISSING_CONFIG":
        return Response.json(
          {
            error: {
              code: "CONFIGURATION_ERROR",
              message:
                "Buffer OAuth is not configured. Set BUFFER_CLIENT_ID, BUFFER_CLIENT_SECRET, and BUFFER_REDIRECT_URI.",
            },
          },
          { status: 500 }
        );
    }
  }

  return Response.redirect(result.url, 302);
}
