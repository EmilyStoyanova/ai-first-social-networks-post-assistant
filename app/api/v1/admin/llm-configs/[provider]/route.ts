import { auth } from "@/lib/auth";
import { setLlmProviderState } from "@/lib/services/admin/set-llm-provider-state.service";
import { setLlmProviderStateSchema } from "@/lib/validators/llm-config.schema";
import { isSupportedProvider } from "@/lib/ai/llm/supported-providers";

interface Context {
  params: Promise<{ provider: string }>;
}

export async function PATCH(request: Request, context: Context) {
  const session = await auth();
  if (!session) {
    return Response.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication required." } },
      { status: 401 }
    );
  }
  if (!session.user.isGlobalAdmin) {
    return Response.json(
      { error: { code: "FORBIDDEN", message: "Global admin access required." } },
      { status: 403 }
    );
  }

  const { provider } = await context.params;
  if (!isSupportedProvider(provider)) {
    return Response.json(
      { error: { code: "NOT_FOUND", message: "Unknown provider." } },
      { status: 404 }
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

  const parsed = setLlmProviderStateSchema.safeParse(body);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Invalid request.";
    return Response.json({ error: { code: "VALIDATION_ERROR", message } }, { status: 400 });
  }

  try {
    const result = await setLlmProviderState(session.user.isGlobalAdmin, provider, parsed.data);
    if (!result.success) {
      switch (result.code) {
        case "NOT_FOUND":
          return Response.json(
            { error: { code: "NOT_FOUND", message: "Unknown provider." } },
            { status: 404 }
          );
        case "PROVIDER_NOT_AVAILABLE":
          return Response.json(
            {
              error: {
                code: "PROVIDER_NOT_AVAILABLE",
                message:
                  "This provider is not configured. Set its environment variables before activating it.",
              },
            },
            { status: 409 }
          );
        case "FORBIDDEN":
          return Response.json(
            { error: { code: "FORBIDDEN", message: "Global admin access required." } },
            { status: 403 }
          );
      }
    }
    return Response.json({ provider: result.provider });
  } catch (err) {
    console.error("[llm-configs PATCH]", err);
    return Response.json(
      { error: { code: "INTERNAL_SERVER_ERROR", message: "Unexpected server error." } },
      { status: 500 }
    );
  }
}
