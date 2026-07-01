import { auth } from "@/lib/auth";
import { updateBrandGuidelinesSchema } from "@/lib/validators/brand-guidelines.schema";
import { updateBrandGuidelines } from "@/lib/services/company/update-brand-guidelines.service";

interface Context {
  params: Promise<{ slug: string }>;
}

export async function PATCH(request: Request, context: Context) {
  const session = await auth();
  if (!session) {
    return Response.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication required." } },
      { status: 401 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: { code: "INVALID_JSON", message: "Invalid JSON body." } },
      { status: 400 }
    );
  }

  const parsed = updateBrandGuidelinesSchema.safeParse(body);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Invalid request.";
    return Response.json({ error: { code: "VALIDATION_ERROR", message } }, { status: 400 });
  }

  const { slug } = await context.params;

  try {
    const result = await updateBrandGuidelines(
      slug,
      session.user.id,
      session.user.isGlobalAdmin,
      parsed.data
    );

    if (!result.success) {
      if (result.code === "FORBIDDEN") {
        return Response.json(
          {
            error: {
              code: "FORBIDDEN",
              message: "Only company owners can update brand guidelines.",
            },
          },
          { status: 403 }
        );
      }
      return Response.json(
        { error: { code: "NOT_FOUND", message: "Company not found." } },
        { status: 404 }
      );
    }

    return Response.json({ brandGuidelines: result.brandGuidelines });
  } catch {
    return Response.json(
      { error: { code: "INTERNAL_SERVER_ERROR", message: "Unexpected server error." } },
      { status: 500 }
    );
  }
}
