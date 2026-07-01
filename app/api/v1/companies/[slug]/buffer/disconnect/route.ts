import { auth } from "@/lib/auth";
import { disconnectBuffer } from "@/lib/services/buffer/disconnect-buffer.service";

interface Context {
  params: Promise<{ slug: string }>;
}

export async function POST(_req: Request, context: Context) {
  const session = await auth();
  if (!session) {
    return Response.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication required." } },
      { status: 401 }
    );
  }

  const { slug } = await context.params;
  const result = await disconnectBuffer(slug, session.user.id, session.user.isGlobalAdmin);

  if (!result.success) {
    switch (result.code) {
      case "NOT_FOUND":
        return Response.json(
          { error: { code: "NOT_FOUND", message: "Company not found." } },
          { status: 404 }
        );
      case "FORBIDDEN":
        return Response.json(
          { error: { code: "FORBIDDEN", message: "Only company owners can disconnect Buffer." } },
          { status: 403 }
        );
    }
  }

  return Response.json({ success: true });
}
