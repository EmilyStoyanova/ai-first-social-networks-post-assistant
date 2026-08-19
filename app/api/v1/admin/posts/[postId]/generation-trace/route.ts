import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getPostGenerationTrace } from "@/lib/services/admin/get-post-generation-trace.service";

/**
 * One post's complete generation trace.
 *
 * Under `/admin/` rather than `/posts/[id]/` deliberately: everything below that
 * path is global-admin-only by convention, and a trace carries the exact prompts,
 * the raw model replies and a frozen copy of the brand guidelines. Putting it
 * beside the post's own routes would make it one forgotten role check away from
 * being company-visible.
 *
 * Never cached — a trace is written after the post, and a stale empty answer
 * would read as "this post has no trace", which is a different fact.
 */
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ postId: string }> }) {
  const session = await auth();
  if (!session) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 }
    );
  }

  const { postId } = await params;
  const result = await getPostGenerationTrace(postId, session.user.isGlobalAdmin);

  if (!result.success) {
    switch (result.code) {
      case "FORBIDDEN":
        // A non-admin is told the same thing whether the post exists or not:
        // the existence of a post is not this endpoint's to disclose.
        return NextResponse.json(
          { error: { code: "NOT_FOUND", message: "Not found" } },
          { status: 404 }
        );
      case "NOT_FOUND":
        return NextResponse.json(
          { error: { code: "NOT_FOUND", message: "Not found" } },
          { status: 404 }
        );
    }
  }

  return NextResponse.json({ trace: result.data });
}
