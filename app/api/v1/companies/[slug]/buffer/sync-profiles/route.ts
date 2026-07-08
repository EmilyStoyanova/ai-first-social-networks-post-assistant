import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { syncBufferProfiles } from "@/lib/services/company/sync-buffer-profiles.service";

interface Context {
  params: Promise<{ slug: string }>;
}

export async function POST(_req: Request, context: Context) {
  const session = await auth();
  if (!session) {
    return Response.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
  }

  const { slug } = await context.params;

  let companyId: string;

  if (session.user.isGlobalAdmin) {
    const company = await prisma.company.findUnique({ where: { slug }, select: { id: true } });
    if (!company) return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
    companyId = company.id;
  } else {
    const membership = await prisma.companyMember.findFirst({
      where: { company: { slug }, userId: session.user.id },
      select: { companyId: true, role: true },
    });
    if (!membership) return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
    if (membership.role !== "owner") {
      return Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 });
    }
    companyId = membership.companyId;
  }

  const result = await syncBufferProfiles(companyId);

  if (!result.success) {
    switch (result.code) {
      case "NO_CONNECTION":
        return Response.json({ error: { code: "NO_CONNECTION" } }, { status: 400 });
      case "TOKEN_EXPIRED":
        return Response.json({ error: { code: "TOKEN_EXPIRED" } }, { status: 400 });
      case "BUFFER_API_ERROR":
        return Response.json(
          { error: { code: "BUFFER_API_ERROR", message: result.message } },
          { status: 502 }
        );
    }
  }

  return Response.json({ data: result.stats });
}
