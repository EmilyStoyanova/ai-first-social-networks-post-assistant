import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { listMedia } from "@/lib/services/company/list-media.service";

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const session = await auth();
  if (!session) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 }
    );
  }

  const { slug } = await params;
  const url = new URL(req.url);
  const sp = url.searchParams;

  const channel = sp.get("channel") ?? undefined;
  const provider = sp.get("provider") ?? undefined;
  const sort = sp.get("sort") ?? undefined;
  const rawPage = sp.get("page");
  const rawPageSize = sp.get("pageSize");
  const page = rawPage ? Math.max(1, parseInt(rawPage, 10)) : 1;
  const pageSize = rawPageSize ? Math.min(100, Math.max(1, parseInt(rawPageSize, 10))) : 24;

  const result = await listMedia(slug, session.user.id, session.user.isGlobalAdmin, {
    channel,
    provider,
    sort,
    page: isNaN(page) ? 1 : page,
    pageSize: isNaN(pageSize) ? 24 : pageSize,
  });

  if (!result.success) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "Not found" } },
      { status: 404 }
    );
  }

  return NextResponse.json({
    media: result.items,
    pagination: {
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      totalPages: Math.ceil(result.total / result.pageSize),
    },
  });
}
