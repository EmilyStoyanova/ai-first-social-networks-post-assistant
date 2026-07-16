import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getUserLlmSettings } from "@/lib/services/user/get-user-llm-settings.service";
import { updatePreferredLlm } from "@/lib/services/user/update-preferred-llm.service";

// null explicitly clears the preference ("use system default").
const bodySchema = z.object({
  llmConfigId: z.string().min(1).nullable(),
});

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
  }

  const settings = await getUserLlmSettings(session.user.id);
  return NextResponse.json({ data: settings });
}

export async function PATCH(req: Request) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: { code: "INVALID_JSON" } }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "Invalid preference." } },
      { status: 400 }
    );
  }

  const result = await updatePreferredLlm(session.user.id, parsed.data.llmConfigId);
  if (!result.success) {
    return NextResponse.json(
      {
        error: {
          code: "INVALID_CONFIG",
          message: "The selected LLM is not available. Pick an active model or the system default.",
        },
      },
      { status: 400 }
    );
  }

  return NextResponse.json({ data: { preferredLlmConfigId: result.preferredLlmConfigId } });
}
