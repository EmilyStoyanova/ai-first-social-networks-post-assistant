import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { generateDraftPost } from "@/lib/services/ai/generate-draft-post.service";
import { parseManualContentSource } from "@/lib/ai/manual-content-source";
import { generationErrorResponse } from "@/lib/http/generation-error-response";

const bodySchema = z.object({
  channel: z
    .string()
    .transform((v) => v.toLowerCase())
    .pipe(z.enum(["facebook", "linkedin", "instagram", "tiktok"])),
  // Omitted = "Default": let the generator inherit the channel's configured
  // posting language (which itself falls back to the company default). An
  // explicit "en"/"bg" overrides it for this generation only.
  contentLanguage: z.enum(["en", "bg"]).optional(),
  // Manual source-link override (v2-1); omitted = inherit source/channel config.
  includeSourceLink: z.boolean().optional(),
  // Manual image override; omitted = inherit the channel's autoGenerateImage.
  // true forces an image, false suppresses one, for this generation only.
  generateImage: z.boolean().optional(),
  // Explicit per-generation LLM config (v2-5); omitted = env-var default provider.
  llmConfigId: z.string().min(1).optional(),
  // "Content source" choice: a sentinel (company rules / company mission) or a
  // ContentSource id of any type. Omitted = company rules, the long-standing
  // pooled behaviour. The id's KIND is not accepted from the client — the
  // service reads the source's type from the DB (see resolveManualContentSource).
  contentSource: z.string().min(1).optional(),
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
      autoGenerateImageOverride: parsed.data.generateImage,
      llmConfigId: parsed.data.llmConfigId,
      contentSource: parseManualContentSource(parsed.data.contentSource),
    }
  );

  // Shared with the bulk route, so a batch that produced nothing answers with
  // exactly the code and status a single generation would have.
  if (!result.success) return generationErrorResponse(result);

  return NextResponse.json({ post: result.post, warnings: result.warnings }, { status: 201 });
}
