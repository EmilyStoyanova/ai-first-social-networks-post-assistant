import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { generatePostImage } from "@/lib/services/ai/generate-post-image.service";
import { generateImageRequestSchema } from "@/lib/ai/image/image-style";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 }
    );
  }

  const { id } = await params;

  // Body is optional; when present, only a valid `imageStyle` is accepted.
  const rawBody = await req.json().catch(() => ({}));
  const parsed = generateImageRequestSchema.safeParse(rawBody ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "Invalid image style" } },
      { status: 400 }
    );
  }

  const result = await generatePostImage(
    id,
    session.user.id,
    session.user.isGlobalAdmin,
    parsed.data.imageStyle,
    parsed.data.imagePrompt
  );

  if (!result.success) {
    switch (result.code) {
      case "NOT_FOUND":
        return NextResponse.json(
          { error: { code: "NOT_FOUND", message: "Post not found" } },
          { status: 404 }
        );
      case "FORBIDDEN":
        return NextResponse.json(
          { error: { code: "FORBIDDEN", message: "Forbidden" } },
          { status: 403 }
        );
      case "NO_IMAGE_PROMPT":
        return NextResponse.json(
          {
            error: {
              code: "NO_IMAGE_PROMPT",
              message: "This post has no image prompt. Regenerate the draft to get one.",
            },
          },
          { status: 422 }
        );
      case "IMAGE_PROVIDER_ERROR":
        return NextResponse.json(
          {
            error: {
              code: "IMAGE_PROVIDER_ERROR",
              message: result.message ?? "Image generation failed",
            },
          },
          { status: 502 }
        );
    }
  }

  return NextResponse.json({ media: result.media }, { status: 201 });
}
