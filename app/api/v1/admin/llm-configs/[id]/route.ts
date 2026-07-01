import { auth } from "@/lib/auth";
import { updateLlmConfig } from "@/lib/services/admin/update-llm-config.service";
import { deleteLlmConfig } from "@/lib/services/admin/delete-llm-config.service";
import { updateLlmConfigSchema } from "@/lib/validators/llm-config.schema";

interface Context {
  params: Promise<{ id: string }>;
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: { code: "INVALID_JSON", message: "Invalid JSON body." } },
      { status: 400 }
    );
  }

  const parsed = updateLlmConfigSchema.safeParse(body);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Invalid request.";
    return Response.json({ error: { code: "VALIDATION_ERROR", message } }, { status: 400 });
  }

  const { id } = await context.params;

  try {
    const result = await updateLlmConfig(session.user.isGlobalAdmin, id, parsed.data);
    if (!result.success) {
      switch (result.code) {
        case "NOT_FOUND":
          return Response.json(
            { error: { code: "NOT_FOUND", message: "LLM configuration not found." } },
            { status: 404 }
          );
        case "FORBIDDEN":
          return Response.json(
            { error: { code: "FORBIDDEN", message: "Global admin access required." } },
            { status: 403 }
          );
      }
    }
    return Response.json({ config: result.config });
  } catch {
    return Response.json(
      { error: { code: "INTERNAL_SERVER_ERROR", message: "Unexpected server error." } },
      { status: 500 }
    );
  }
}

export async function DELETE(_req: Request, context: Context) {
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

  const { id } = await context.params;

  try {
    const result = await deleteLlmConfig(session.user.isGlobalAdmin, id);
    if (!result.success) {
      switch (result.code) {
        case "NOT_FOUND":
          return Response.json(
            { error: { code: "NOT_FOUND", message: "LLM configuration not found." } },
            { status: 404 }
          );
        case "CANNOT_DELETE_ACTIVE":
          return Response.json(
            {
              error: {
                code: "CANNOT_DELETE_ACTIVE",
                message:
                  "Cannot delete the active LLM configuration. Activate another provider first.",
              },
            },
            { status: 400 }
          );
        case "FORBIDDEN":
          return Response.json(
            { error: { code: "FORBIDDEN", message: "Global admin access required." } },
            { status: 403 }
          );
      }
    }
    return new Response(null, { status: 204 });
  } catch {
    return Response.json(
      { error: { code: "INTERNAL_SERVER_ERROR", message: "Unexpected server error." } },
      { status: 500 }
    );
  }
}
