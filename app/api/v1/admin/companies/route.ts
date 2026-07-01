import { auth } from "@/lib/auth";
import { listAdminCompanies } from "@/lib/services/admin/list-companies.service";

export async function GET() {
  const session = await auth();

  if (!session) {
    return Response.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication required." } },
      { status: 401 }
    );
  }

  if (!session.user.isGlobalAdmin) {
    return Response.json(
      { error: { code: "FORBIDDEN", message: "Global admin access required." } },
      { status: 403 }
    );
  }

  try {
    const result = await listAdminCompanies(session.user.isGlobalAdmin);
    if (!result.success) {
      return Response.json(
        { error: { code: "FORBIDDEN", message: "Global admin access required." } },
        { status: 403 }
      );
    }
    return Response.json({ companies: result.companies });
  } catch {
    return Response.json(
      { error: { code: "INTERNAL_SERVER_ERROR", message: "Unexpected server error." } },
      { status: 500 }
    );
  }
}
