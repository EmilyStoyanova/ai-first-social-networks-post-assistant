import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { listPostMedia } from "@/lib/services/posts/list-post-media.service";

/**
 * The images this post is already holding — what it is showing, and what the
 * last switch displaced.
 *
 * Read-only: it tells the image picker which of the company's assets belong to
 * this post, so the AI tab can offer them back instead of a regeneration and the
 * gallery can float them to the top. Attaching one is still the existing POST to
 * attach-media.
 *
 * An empty array is an ordinary answer — a post with no image yet.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 }
    );
  }

  const { id } = await params;
  const result = await listPostMedia(id, session.user.id, session.user.isGlobalAdmin);

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
    }
  }

  return NextResponse.json({ media: result.media });
}
