import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { updatePost } from "@/lib/services/posts/post-editor.service";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 }
    );
  }

  const { id } = await params;

  let body: { content?: unknown; hashtags?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { error: { code: "BAD_REQUEST", message: "Invalid JSON" } },
      { status: 400 }
    );
  }

  if (typeof body.content !== "string") {
    return NextResponse.json(
      { error: { code: "BAD_REQUEST", message: "content is required" } },
      { status: 400 }
    );
  }

  const result = await updatePost(id, session.user.id, session.user.isGlobalAdmin, {
    content: body.content,
    hashtags: Array.isArray(body.hashtags)
      ? (body.hashtags as unknown[]).filter((h): h is string => typeof h === "string")
      : [],
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
          { error: { code: "FORBIDDEN", message: "Access denied" } },
          { status: 403 }
        );
      case "POST_LOCKED":
        return NextResponse.json(
          { error: { code: "POST_LOCKED", message: result.message ?? "Post cannot be edited" } },
          { status: 409 }
        );
      case "VALIDATION_ERROR":
        return NextResponse.json(
          {
            error: {
              code: "VALIDATION_ERROR",
              message: result.message ?? "Validation failed",
            },
          },
          { status: 422 }
        );
    }
  }

  return NextResponse.json({ ok: true });
}
