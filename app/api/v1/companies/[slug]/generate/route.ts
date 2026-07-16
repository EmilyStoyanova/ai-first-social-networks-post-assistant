import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { generateDraftPost } from "@/lib/services/ai/generate-draft-post.service";

const bodySchema = z.object({
  channel: z
    .string()
    .transform((v) => v.toLowerCase())
    .pipe(z.enum(["facebook", "linkedin", "instagram", "tiktok"])),
  contentLanguage: z.enum(["en", "bg"]).optional().default("en"),
  // Manual source-link override (v2-1); omitted = inherit source/channel config.
  includeSourceLink: z.boolean().optional(),
  // Explicit per-generation LLM config (v2-5); omitted = env-var default provider.
  llmConfigId: z.string().min(1).optional(),
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

  const result = await generateDraftPost(
    slug,
    parsed.data.channel,
    session.user.id,
    session.user.isGlobalAdmin,
    {
      contentLanguage: parsed.data.contentLanguage,
      includeSourceLinkOverride: parsed.data.includeSourceLink,
      llmConfigId: parsed.data.llmConfigId,
    }
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
      case "LLM_CONFIG_NOT_FOUND":
        return NextResponse.json(
          {
            error: {
              code: "LLM_CONFIG_NOT_FOUND",
              message: "The selected LLM is no longer available. Pick another or use the default.",
            },
          },
          { status: 404 }
        );
      case "PROVIDER_CONFIG_MISSING":
        return NextResponse.json(
          {
            error: {
              code: "PROVIDER_CONFIG_MISSING",
              message: result.message ?? "The selected LLM is missing required configuration.",
            },
          },
          { status: 503 }
        );
      case "LLM_RATE_LIMITED": {
        const retryAfterSec =
          result.retryAfterMs !== undefined
            ? Math.max(1, Math.ceil(result.retryAfterMs / 1000))
            : undefined;
        return NextResponse.json(
          {
            error: {
              code: "LLM_RATE_LIMITED",
              message: "The AI provider is temporarily rate limited. Please try again shortly.",
              retryAfterMs: result.retryAfterMs,
            },
          },
          {
            status: 429,
            // Standard header so clients/proxies can honour the provider's wait.
            headers: retryAfterSec !== undefined ? { "retry-after": String(retryAfterSec) } : {},
          }
        );
      }
      case "LLM_PROVIDER_ERROR":
        return NextResponse.json(
          {
            error: { code: "LLM_PROVIDER_ERROR", message: result.message ?? "LLM provider error" },
          },
          { status: 502 }
        );
      case "LLM_RESPONSE_PARSE_ERROR":
        return NextResponse.json(
          {
            error: {
              code: "LLM_RESPONSE_PARSE_ERROR",
              message: result.message ?? "Failed to parse LLM response",
            },
          },
          { status: 502 }
        );
      case "POST_TOO_LONG_WITH_URL":
        return NextResponse.json(
          {
            error: {
              code: "POST_TOO_LONG_WITH_URL",
              message: result.message ?? "Post text plus source URL exceeds the channel text limit",
            },
          },
          { status: 422 }
        );
      case "NO_FEED_ITEMS_AVAILABLE":
        return NextResponse.json(
          {
            error: {
              code: "NO_FEED_ITEMS_AVAILABLE",
              message:
                "No unused source articles are available to generate from right now. Ingest a content source to fetch new articles, or add an RSS source.",
            },
          },
          { status: 409 }
        );
      case "CANNOT_GENERATE_UNIQUE_POST":
        return NextResponse.json(
          {
            error: {
              code: "CANNOT_GENERATE_UNIQUE_POST",
              message:
                result.message ??
                "Could not generate a sufficiently unique post. Try again later or add fresh source material.",
              // Diagnostics so the UI can explain WHY and after how many tries.
              reason: result.reason,
              attempts: result.attempts,
            },
          },
          { status: 409 }
        );
    }
  }

  return NextResponse.json({ post: result.post, warnings: result.warnings }, { status: 201 });
}
