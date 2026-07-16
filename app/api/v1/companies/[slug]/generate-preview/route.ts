import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { buildGenerationContext } from "@/lib/services/ai/build-generation-context.service";
import { resolveGenerationAspect } from "@/lib/services/ai/resolve-generation-aspect.service";
import { buildPrompts } from "@/lib/ai/prompt-builder";
import { getLlmProvider } from "@/lib/ai/llm/llm-provider-factory";
import { prisma } from "@/lib/db/client";
import { type SocialChannel } from "@prisma/client";

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
              message: "No default AI model is configured. Contact an administrator.",
            },
          },
          { status: 503 }
        );
    }
  }

  const { context, companyId } = result;

  // ── Aspect mining (same logic as real generation) ─────────────────────────
  // Query recent posts so we can load the existing aspect pool for this context.
  const recentRows = await prisma.post.findMany({
    where: { companyId, channel: parsed.data.channel as SocialChannel },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { promptSnapshot: true },
  });
  const snapshots = recentRows.map((r) => r.promptSnapshot as Record<string, unknown> | null);

  // Get the provider for potential extraction (graceful no-op if unavailable).
  let selectedAspect: import("@/lib/ai/content-aspect").ContentAspect | undefined;
  try {
    const provider =
      process.env.AI_MOCK_MODE === "true"
        ? { generate: async () => ({ text: "[]" }) }
        : getLlmProvider();

    const aspectResult = await resolveGenerationAspect({
      feedItems: context.feedItems,
      snapshots,
      provider,
    });
    selectedAspect = aspectResult.aspect;
  } catch {
    // No provider or extraction failed — show prompt without aspect (same as generation would do)
    selectedAspect = undefined;
  }

  const { systemPrompt, userPrompt } = buildPrompts(context, parsed.data.contentLanguage, [], {
    aspect: selectedAspect,
  });

  return NextResponse.json({
    provider: context.llm.provider,
    model: context.llm.model,
    systemPrompt,
    userPrompt,
    selectedAspect: selectedAspect ?? null,
  });
}
