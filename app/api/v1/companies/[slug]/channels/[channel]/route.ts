import { auth } from "@/lib/auth";
import { upsertChannelConfigSchema } from "@/lib/validators/channel-config.schema";
import { upsertChannelConfig } from "@/lib/services/company/upsert-channel-config.service";

interface Context {
  params: Promise<{ slug: string; channel: string }>;
}

export async function PUT(request: Request, context: Context) {
  const session = await auth();
  if (!session) {
    return Response.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication required." } },
      { status: 401 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: { code: "INVALID_JSON", message: "Invalid JSON body." } },
      { status: 400 }
    );
  }

  const parsed = upsertChannelConfigSchema.safeParse(body);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Invalid request.";
    return Response.json({ error: { code: "VALIDATION_ERROR", message } }, { status: 400 });
  }

  const { slug, channel } = await context.params;
  const result = await upsertChannelConfig(
    slug,
    channel,
    session.user.id,
    session.user.isGlobalAdmin,
    parsed.data
  );

  if (!result.success) {
    switch (result.code) {
      case "NOT_FOUND":
        return Response.json(
          { error: { code: "NOT_FOUND", message: "Company not found." } },
          { status: 404 }
        );
      case "FORBIDDEN":
        return Response.json(
          {
            error: {
              code: "FORBIDDEN",
              message: "Only company owners can update channel configurations.",
            },
          },
          { status: 403 }
        );
      case "INVALID_CHANNEL":
        return Response.json(
          {
            error: {
              code: "INVALID_CHANNEL",
              message: "Invalid channel. Must be facebook, linkedin, instagram, or tiktok.",
            },
          },
          { status: 400 }
        );
    }
  }

  return Response.json({ channel: result.config });
}
