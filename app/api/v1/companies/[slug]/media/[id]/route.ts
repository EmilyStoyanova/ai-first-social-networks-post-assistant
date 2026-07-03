import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { deleteMedia } from "@/lib/services/media/delete-media.service";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ slug: string; id: string }> }
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
  }

  const { slug, id } = await params;

  const result = await deleteMedia(slug, id, session.user.id, session.user.isGlobalAdmin);

  if (!result.success) {
    switch (result.code) {
      case "NOT_FOUND":
        return NextResponse.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
      case "FORBIDDEN":
        return NextResponse.json(
          { error: { code: "FORBIDDEN", message: result.message } },
          { status: 403 }
        );
    }
  }

  return NextResponse.json({}, { status: 200 });
}
