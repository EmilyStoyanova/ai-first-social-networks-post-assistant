import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { reschedulePost } from "@/lib/services/posts/reschedule-post.service";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 }
    );
  }

  const { id } = await params;

  let body: { scheduledFor?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { error: { code: "BAD_REQUEST", message: "Invalid JSON" } },
      { status: 400 }
    );
  }

  if (typeof body.scheduledFor !== "string") {
    return NextResponse.json(
      { error: { code: "BAD_REQUEST", message: "scheduledFor is required" } },
      { status: 400 }
    );
  }

  const result = await reschedulePost(id, session.user.id, session.user.isGlobalAdmin, {
    scheduledFor: body.scheduledFor,
  });

  if (!result.success) {
    switch (result.code) {
      case "NOT_FOUND":
        return NextResponse.json(
          { error: { code: "NOT_FOUND", message: "Post not found" } },
          { status: 404 }
        );
      case "FORBIDDEN":
        return NextResponse.json(
          {
            error: {
              code: "FORBIDDEN",
              message: "Only owners and admins can reschedule an approved post",
            },
          },
          { status: 403 }
        );
      // 409, with the post's REAL status alongside. The caller almost always
      // got here by holding a stale card — the publishing sweep moved the post
      // to `sent_to_buffer` while the page sat open — so answering with the
      // current status is what lets the card repaint and stop offering a
      // control that can no longer succeed. Without it the only way out is a
      // page reload, which is not something an error message can ask for.
      case "SCHEDULE_LOCKED":
        return NextResponse.json(
          {
            error: { code: "SCHEDULE_LOCKED", message: result.message, status: result.status },
          },
          { status: 409 }
        );
      case "INVALID_SCHEDULE":
        return NextResponse.json(
          { error: { code: "INVALID_SCHEDULE", message: result.message } },
          { status: 422 }
        );
    }
  }

  return NextResponse.json({ scheduledFor: result.scheduledFor });
}
