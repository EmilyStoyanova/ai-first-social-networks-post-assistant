import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { resolveSourceImage } from "@/lib/services/posts/resolve-source-image.service";

/**
 * The image of the article this post was written from, if there is one.
 *
 * Read-only: it answers what the "Source article" tab of the image picker should
 * show. Nothing about the post changes until the user picks the image, which is
 * a POST to use-source-image.
 *
 * `{ sourceImageUrl: null }` is a perfectly ordinary answer — no article, or an
 * article with no usable image. The tab says so rather than erroring.
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
  const result = await resolveSourceImage(id, session.user.id, session.user.isGlobalAdmin);

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

  return NextResponse.json({ sourceImageUrl: result.sourceImageUrl });
}
