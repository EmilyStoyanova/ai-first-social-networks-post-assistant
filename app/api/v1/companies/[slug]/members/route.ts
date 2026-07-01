import { auth } from "@/lib/auth";
import { inviteMemberSchema } from "@/lib/validators/company-member.schema";
import { listMembers } from "@/lib/services/company/list-members.service";
import { inviteMember } from "@/lib/services/company/invite-member.service";

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

  try {
    const result = await listMembers(slug, session.user.id, session.user.isGlobalAdmin);
    if (!result.success) {
      return Response.json(
        { error: { code: "NOT_FOUND", message: "Company not found." } },
        { status: 404 }
      );
    }
    return Response.json(result.members);
  } catch {
    return Response.json(
      { error: { code: "INTERNAL_SERVER_ERROR", message: "Unexpected server error." } },
      { status: 500 }
    );
  }
}

export async function POST(request: Request, context: Context) {
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

  const parsed = inviteMemberSchema.safeParse(body);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Invalid request.";
    return Response.json({ error: { code: "VALIDATION_ERROR", message } }, { status: 400 });
  }

  const { slug } = await context.params;

  try {
    const result = await inviteMember(
      slug,
      session.user.id,
      session.user.isGlobalAdmin,
      parsed.data
    );

    if (!result.success) {
      switch (result.code) {
        case "NOT_FOUND":
          return Response.json(
            { error: { code: "NOT_FOUND", message: "Company not found." } },
            { status: 404 }
          );
        case "FORBIDDEN":
          return Response.json(
            { error: { code: "FORBIDDEN", message: "Only company owners can invite members." } },
            { status: 403 }
          );
        case "USER_NOT_FOUND":
          return Response.json(
            {
              error: {
                code: "USER_NOT_FOUND",
                message: "No registered user with that email address.",
              },
            },
            { status: 404 }
          );
        case "ALREADY_MEMBER":
          return Response.json(
            { error: { code: "ALREADY_MEMBER", message: "This user is already a member." } },
            { status: 409 }
          );
      }
    }

    return Response.json({ member: result.member }, { status: 201 });
  } catch {
    return Response.json(
      { error: { code: "INTERNAL_SERVER_ERROR", message: "Unexpected server error." } },
      { status: 500 }
    );
  }
}
