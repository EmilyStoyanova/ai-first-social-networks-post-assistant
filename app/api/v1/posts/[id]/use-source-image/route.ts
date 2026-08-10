import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { applySourceImage } from "@/lib/services/posts/apply-source-image.service";

/**
 * Attaches the original article's image to a post, importing it into our own
 * media storage on the way. The post's previous image is preserved, not deleted
 * — see use-previous-image for the way back.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 }
    );
  }

  const { id } = await params;
  const result = await applySourceImage(id, session.user.id, session.user.isGlobalAdmin);

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
      case "NO_SOURCE_IMAGE":
        return NextResponse.json(
          {
            error: {
              code: "NO_SOURCE_IMAGE",
              message: "This post has no source article image.",
            },
          },
          { status: 422 }
        );
      // The address itself is unusable — not a transient failure, so 422.
      case "UNSAFE_URL":
      case "UNSUPPORTED_TYPE":
      case "IMAGE_TOO_LARGE":
        return NextResponse.json(
          {
            error: {
              code:
                result.code === "UNSUPPORTED_TYPE"
                  ? "UNSUPPORTED_TYPE"
                  : "SOURCE_IMAGE_UNAVAILABLE",
              message: result.message ?? "The source image could not be used.",
            },
          },
          { status: 422 }
        );
      // The publisher's server, or ours, let us down — an upstream failure.
      case "FETCH_FAILED":
        return NextResponse.json(
          {
            error: {
              code: "SOURCE_IMAGE_UNAVAILABLE",
              message: result.message ?? "The source image could not be downloaded.",
            },
          },
          { status: 502 }
        );
      case "UPLOAD_FAILED":
        return NextResponse.json(
          {
            error: { code: "UPLOAD_FAILED", message: result.message ?? "Image upload failed." },
          },
          { status: 502 }
        );
    }
  }

  return NextResponse.json({
    media: result.media,
    previousMediaId: result.previousMediaId,
    unchanged: result.unchanged,
  });
}
