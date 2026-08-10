import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { restorePreviousImage } from "@/lib/services/posts/restore-previous-image.service";

/**
 * Restores the image displaced by the last source-image switch — in practice,
 * the AI image the user came from. A pointer swap: nothing is regenerated and
 * nothing is deleted.
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
  const result = await restorePreviousImage(id, session.user.id, session.user.isGlobalAdmin);

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
      case "NO_PREVIOUS_IMAGE":
        return NextResponse.json(
          {
            error: {
              code: "NO_PREVIOUS_IMAGE",
              message: "This post has no earlier image to restore.",
            },
          },
          { status: 422 }
        );
    }
  }

  return NextResponse.json({ media: result.media, previousMediaId: result.previousMediaId });
}
