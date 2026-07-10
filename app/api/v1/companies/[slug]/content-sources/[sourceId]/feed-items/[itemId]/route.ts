import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { toggleFeedItem } from "@/lib/services/company/toggle-feed-item.service";

const PatchSchema = z.object({ enabled: z.boolean() });

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ slug: string; sourceId: string; itemId: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });

  const { slug, sourceId, itemId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: { code: "INVALID_JSON" } }, { status: 400 });
  }

  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success)
    return NextResponse.json({ error: { code: "VALIDATION_ERROR" } }, { status: 422 });

  const result = await toggleFeedItem(
    slug,
    sourceId,
    itemId,
    parsed.data.enabled,
    session.user.id,
    session.user.isGlobalAdmin
  );

  if (!result.success) {
    const status = result.code === "NOT_FOUND" ? 404 : 403;
    return NextResponse.json({ error: { code: result.code } }, { status });
  }
  return NextResponse.json({ item: result.item });
}
