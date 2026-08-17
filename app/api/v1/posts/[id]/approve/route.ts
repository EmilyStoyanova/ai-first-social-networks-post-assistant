import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { approvePost } from "@/lib/services/posts/post-approval.service";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 }
    );
  }

  const { id } = await params;
  const result = await approvePost(id, session.user.id, session.user.isGlobalAdmin);

  if (!result.success) {
    switch (result.code) {
      case "NOT_FOUND":
        return NextResponse.json(
          { error: { code: "NOT_FOUND", message: "Post not found" } },
          { status: 404 }
        );
      case "FORBIDDEN":
        return NextResponse.json(
          { error: { code: "FORBIDDEN", message: "Only owners and admins can approve posts" } },
          { status: 403 }
        );
      case "INVALID_TRANSITION":
        return NextResponse.json(
          {
            error: {
              code: "INVALID_TRANSITION",
              message: result.message ?? "Invalid status transition",
            },
          },
          { status: 422 }
        );
      case "SCHEDULE_MISSED":
        // 409: the post is approvable and the caller may approve it — its own
        // publish time is what conflicts, and a reschedule resolves it. Enforced
        // here and not only in the card, so this route cannot be used to approve
        // a post into a time that no longer exists.
        return NextResponse.json(
          {
            error: {
              code: "SCHEDULE_MISSED",
              message:
                result.message ??
                "The scheduled publication time has passed. Choose a new time first.",
            },
          },
          { status: 409 }
        );
    }
  }

  return NextResponse.json({ status: result.status });
}
