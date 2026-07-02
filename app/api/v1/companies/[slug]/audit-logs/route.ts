import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCompany } from "@/lib/services/company/get-company.service";
import { listCompanyAuditLogs } from "@/lib/services/audit/audit-log.service";

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const session = await auth();
  if (!session) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 }
    );
  }

  const { slug } = await params;

  const company = await getCompany(slug, session.user.id, session.user.isGlobalAdmin);
  if (!company) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "Company not found" } },
      { status: 404 }
    );
  }

  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? undefined;
  const postId = url.searchParams.get("postId") ?? undefined;
  const filterUserId = url.searchParams.get("userId") ?? undefined;
  const fromStr = url.searchParams.get("from");
  const toStr = url.searchParams.get("to");
  const limitStr = url.searchParams.get("limit");

  const from = fromStr ? new Date(fromStr) : undefined;
  const to = toStr ? new Date(toStr) : undefined;
  const limit = limitStr ? Math.min(parseInt(limitStr, 10), 200) : 50;

  const logs = await listCompanyAuditLogs(company.id, {
    action,
    postId,
    userId: filterUserId,
    from,
    to,
    limit,
  });

  return NextResponse.json({ logs });
}
