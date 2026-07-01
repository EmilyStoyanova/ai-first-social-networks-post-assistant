import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { listContentSources } from "@/lib/services/company/list-content-sources.service";
import { createContentSource } from "@/lib/services/company/create-content-source.service";
import { contentSourceSchema } from "@/lib/validators/content-source.schema";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: { message: "Unauthorized" } }, { status: 401 });

  const { slug } = await params;
  const result = await listContentSources(slug, session.user.id, session.user.isGlobalAdmin);

  if (!result.success) {
    return NextResponse.json({ error: { message: "Not found" } }, { status: 404 });
  }
  return NextResponse.json({ sources: result.sources });
}

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: { message: "Unauthorized" } }, { status: 401 });

  const { slug } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: { message: "Invalid JSON" } }, { status: 400 });
  }

  const parsed = contentSourceSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { message: "Validation failed", issues: parsed.error.issues } },
      { status: 422 }
    );
  }

  const result = await createContentSource(
    slug,
    session.user.id,
    session.user.isGlobalAdmin,
    parsed.data
  );

  if (!result.success) {
    const status = result.code === "NOT_FOUND" ? 404 : 403;
    const message = result.code === "NOT_FOUND" ? "Not found" : "Forbidden";
    return NextResponse.json({ error: { message } }, { status });
  }
  return NextResponse.json({ source: result.source }, { status: 201 });
}
