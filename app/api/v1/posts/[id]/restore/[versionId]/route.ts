import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { restoreVersion } from "@/lib/services/posts/post-editor.service";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; versionId: string }> }
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 }
    );
  }

  const { id, versionId } = await params;
  const result = await restoreVersion(id, versionId, session.user.id, session.user.isGlobalAdmin);

  if (!result.success) {
    switch (result.code) {
      case "NOT_FOUND":
        return NextResponse.json(
          { error: { code: "NOT_FOUND", message: "Post not found" } },
          { status: 404 }
        );
      case "FORBIDDEN":
        return NextResponse.json(
          { error: { code: "FORBIDDEN", message: "Only owners can restore versions" } },
          { status: 403 }
        );
      case "VERSION_NOT_FOUND":
        return NextResponse.json(
          { error: { code: "VERSION_NOT_FOUND", message: "Version not found" } },
          { status: 404 }
        );
      case "POST_LOCKED":
        return NextResponse.json(
          { error: { code: "POST_LOCKED", message: result.message ?? "Post cannot be edited" } },
          { status: 409 }
        );
    }
  }

  return NextResponse.json({ ok: true });
}
