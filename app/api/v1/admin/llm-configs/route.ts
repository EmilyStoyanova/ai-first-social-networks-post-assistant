import { auth } from "@/lib/auth";
import { listLlmConfigs } from "@/lib/services/admin/list-llm-configs.service";
import { createLlmConfig } from "@/lib/services/admin/create-llm-config.service";
import { createLlmConfigSchema } from "@/lib/validators/llm-config.schema";

export async function GET() {
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

  try {
    const result = await listLlmConfigs(session.user.isGlobalAdmin);
    if (!result.success) {
      return Response.json(
        { error: { code: "FORBIDDEN", message: "Global admin access required." } },
        { status: 403 }
      );
    }
    return Response.json({ configs: result.configs });
  } catch {
    return Response.json(
      { error: { code: "INTERNAL_SERVER_ERROR", message: "Unexpected server error." } },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
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

  const parsed = createLlmConfigSchema.safeParse(body);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Invalid request.";
    return Response.json({ error: { code: "VALIDATION_ERROR", message } }, { status: 400 });
  }

  try {
    const result = await createLlmConfig(session.user.isGlobalAdmin, session.user.id, parsed.data);
    if (!result.success) {
      return Response.json(
        { error: { code: "FORBIDDEN", message: "Global admin access required." } },
        { status: 403 }
      );
    }
    return Response.json({ config: result.config }, { status: 201 });
  } catch {
    return Response.json(
      { error: { code: "INTERNAL_SERVER_ERROR", message: "Unexpected server error." } },
      { status: 500 }
    );
  }
}
