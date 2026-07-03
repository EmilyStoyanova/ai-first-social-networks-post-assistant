import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { buildGenerationContext } from "@/lib/services/ai/build-generation-context.service";
import { buildPrompts } from "@/lib/ai/prompt-builder";

const bodySchema = z.object({
  channel: z
    .string()
    .transform((v) => v.toLowerCase())
    .pipe(z.enum(["facebook", "linkedin", "instagram", "tiktok"])),
  contentLanguage: z.enum(["en", "bg"]).optional().default("en"),
});

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const session = await auth();
  if (!session) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 }
    );
  }

  const { slug } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: "INVALID_JSON", message: "Invalid JSON" } },
      { status: 400 }
    );
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          issues: parsed.error.issues,
        },
      },
      { status: 422 }
    );
  }

  const result = await buildGenerationContext(
    slug,
    parsed.data.channel,
    session.user.id,
    session.user.isGlobalAdmin
  );

  if (!result.success) {
    switch (result.code) {
      case "NOT_FOUND":
        return NextResponse.json(
          { error: { code: "NOT_FOUND", message: "Not found" } },
          { status: 404 }
        );
      case "FORBIDDEN":
        return NextResponse.json(
          { error: { code: "FORBIDDEN", message: "Forbidden" } },
          { status: 403 }
        );
      case "INVALID_CHANNEL":
        return NextResponse.json(
          {
            error: {
              code: "INVALID_CHANNEL",
              message: "Invalid channel. Must be one of: facebook, linkedin, instagram, tiktok",
            },
          },
          { status: 422 }
        );
      case "NO_ACTIVE_PROVIDER":
        return NextResponse.json(
          {
            error: {
              code: "NO_ACTIVE_PROVIDER",
              message: "No active LLM provider configured. Configure one in Admin → LLM Providers.",
            },
          },
          { status: 503 }
        );
    }
  }

  const { systemPrompt, userPrompt } = buildPrompts(result.context, parsed.data.contentLanguage);

  return NextResponse.json({
    provider: result.context.llm.provider,
    model: result.context.llm.model,
    systemPrompt,
    userPrompt,
  });
}
