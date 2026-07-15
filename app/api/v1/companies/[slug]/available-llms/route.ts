import { auth } from "@/lib/auth";
import { getAvailableLlms } from "@/lib/services/company/get-available-llms.service";

interface Context {
  params: Promise<{ slug: string }>;
}

export async function GET(_req: Request, context: Context) {
  const session = await auth();
  if (!session) {
    return Response.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication required." } },
      { status: 401 }
    );
  }

  const { slug } = await context.params;
  const result = await getAvailableLlms(slug, session.user.id, session.user.isGlobalAdmin);

  if (!result.success) {
    return Response.json(
      { error: { code: "NOT_FOUND", message: "Company not found." } },
      { status: 404 }
    );
  }

  return Response.json({ data: result.llms });
}
