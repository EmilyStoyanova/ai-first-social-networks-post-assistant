import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { listPostAuditLogs } from "@/lib/services/audit/audit-log.service";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 }
    );
  }

  const { id } = await params;

  const post = await prisma.post.findUnique({
    where: { id },
    select: { companyId: true },
  });

  if (!post) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "Post not found" } },
      { status: 404 }
    );
  }

  if (!session.user.isGlobalAdmin) {
    const membership = await prisma.companyMember.findFirst({
      where: { companyId: post.companyId, userId: session.user.id },
      select: { role: true },
    });
    if (!membership) {
      return NextResponse.json(
        { error: { code: "NOT_FOUND", message: "Post not found" } },
        { status: 404 }
      );
    }
  }

  const logs = await listPostAuditLogs(id);

  return NextResponse.json({ logs });
}
