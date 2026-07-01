import { auth } from "@/lib/auth";
import { listAdminUsers } from "@/lib/services/admin/list-users.service";

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
    const result = await listAdminUsers(session.user.isGlobalAdmin);
    if (!result.success) {
      return Response.json(
        { error: { code: "FORBIDDEN", message: "Global admin access required." } },
        { status: 403 }
      );
    }
    return Response.json({ users: result.users });
  } catch {
    return Response.json(
      { error: { code: "INTERNAL_SERVER_ERROR", message: "Unexpected server error." } },
      { status: 500 }
    );
  }
}
