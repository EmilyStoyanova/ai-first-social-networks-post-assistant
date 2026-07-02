import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { listPosts } from "@/lib/services/company/list-posts.service";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const session = await auth();
  if (!session) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 }
    );
  }

  const { slug } = await params;
  const result = await listPosts(slug, session.user.id, session.user.isGlobalAdmin);

  if (!result.success) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "Not found" } },
      { status: 404 }
    );
  }

  return NextResponse.json({ posts: result.posts });
}
