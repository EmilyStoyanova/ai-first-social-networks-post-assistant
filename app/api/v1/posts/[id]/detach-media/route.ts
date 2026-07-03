import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { detachMedia } from "@/lib/services/posts/detach-media.service";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
  }

  const { id } = await params;

  const result = await detachMedia(id, session.user.id, session.user.isGlobalAdmin);

  if (!result.success) {
    switch (result.code) {
      case "NOT_FOUND":
        return NextResponse.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
      case "FORBIDDEN":
        return NextResponse.json({ error: { code: "FORBIDDEN" } }, { status: 403 });
      case "INVALID_STATUS":
        return NextResponse.json(
          { error: { code: "INVALID_STATUS", message: result.message } },
          { status: 422 }
        );
    }
  }

  return NextResponse.json({}, { status: 200 });
}
