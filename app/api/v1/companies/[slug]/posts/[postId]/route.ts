import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { deletePost } from "@/lib/services/company/delete-post.service";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ slug: string; postId: string }> }
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 }
    );
  }

  const { slug, postId } = await params;
  const result = await deletePost(slug, postId, session.user.id, session.user.isGlobalAdmin);

  if (!result.success) {
    switch (result.code) {
      case "NOT_FOUND":
        return NextResponse.json(
          { error: { code: "NOT_FOUND", message: "Not found" } },
          { status: 404 }
        );
      case "FORBIDDEN":
        return NextResponse.json(
          { error: { code: "FORBIDDEN", message: result.message ?? "Forbidden" } },
          { status: 403 }
        );
      // Anything past `draft` has been reviewed, approved or sent — 409, because
      // the request is well-formed and the caller may not repeat it.
      case "INVALID_STATUS":
        return NextResponse.json(
          { error: { code: "INVALID_STATUS", message: result.message ?? "Not a draft" } },
          { status: 409 }
        );
    }
  }

  return new NextResponse(null, { status: 204 });
}
