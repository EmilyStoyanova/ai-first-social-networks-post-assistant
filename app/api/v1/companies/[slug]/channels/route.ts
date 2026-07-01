import { auth } from "@/lib/auth";
import { listChannelConfigs } from "@/lib/services/company/list-channel-configs.service";

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
  const result = await listChannelConfigs(slug, session.user.id, session.user.isGlobalAdmin);

  if (!result.success) {
    return Response.json(
      { error: { code: "NOT_FOUND", message: "Company not found." } },
      { status: 404 }
    );
  }

  return Response.json({ channels: result.configs });
}
