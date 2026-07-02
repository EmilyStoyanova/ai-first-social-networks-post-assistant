import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { generatePostImage } from "@/lib/services/ai/generate-post-image.service";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 }
    );
  }

  const { id } = await params;

  const result = await generatePostImage(id, session.user.id, session.user.isGlobalAdmin);

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
