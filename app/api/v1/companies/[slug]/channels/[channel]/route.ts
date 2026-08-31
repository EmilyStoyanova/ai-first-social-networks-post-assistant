import { auth } from "@/lib/auth";
import {
  isInsufficientPostingDays,
  upsertChannelConfigSchema,
} from "@/lib/validators/channel-config.schema";
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
    // The posting-day rule gets its own code so the settings page can say what
    // is actually wrong — a generic "invalid request" would leave an owner to
    // guess which of eight fields the server disliked.
    if (isInsufficientPostingDays(parsed.error)) {
      return Response.json(
        {
          error: {
            code: "INSUFFICIENT_POSTING_DAYS",
            message: "This channel posts more times a week than it has configured posting days.",
          },
        },
        { status: 400 }
      );
    }
    const message = parsed.error.issues[0]?.message ?? "Invalid request.";
    return Response.json({ error: { code: "VALIDATION_ERROR", message } }, { status: 400 });
  }

  // [channel] segment is now the config UUID (not the platform name).
  const { slug, channel: configId } = await context.params;
  const result = await upsertChannelConfig(
    slug,
    configId,
    session.user.id,
    session.user.isGlobalAdmin,
    parsed.data
  );

  if (!result.success) {
    if (result.code === "NOT_FOUND") {
      return Response.json(
        { error: { code: "NOT_FOUND", message: "Channel config not found." } },
        { status: 404 }
      );
    }
    // The service enforces the posting-day rule again at the write; unreachable
    // through this route, since the schema above already refused it.
    if (result.code === "INSUFFICIENT_POSTING_DAYS") {
      return Response.json(
        {
          error: {
            code: "INSUFFICIENT_POSTING_DAYS",
            message: "This channel posts more times a week than it has configured posting days.",
          },
        },
        { status: 400 }
      );
    }
    return Response.json(
      {
        error: {
          code: "FORBIDDEN",
          message: "Only company owners can update channel configurations.",
        },
      },
      { status: 403 }
    );
  }

  return Response.json({ channel: result.config });
}
