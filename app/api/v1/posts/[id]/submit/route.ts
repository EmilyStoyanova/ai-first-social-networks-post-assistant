import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { submitForApproval } from "@/lib/services/posts/post-approval.service";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 }
    );
  }

  const { id } = await params;
  const result = await submitForApproval(id, session.user.id, session.user.isGlobalAdmin);

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
    }
  }

  return NextResponse.json({ status: result.status });
}
