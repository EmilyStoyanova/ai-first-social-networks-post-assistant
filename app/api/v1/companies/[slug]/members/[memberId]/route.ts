import { auth } from "@/lib/auth";
import { updateMemberRoleSchema } from "@/lib/validators/company-member.schema";
import { updateMemberRole } from "@/lib/services/company/update-member-role.service";
import { removeMember } from "@/lib/services/company/remove-member.service";

interface Context {
  params: Promise<{ slug: string; memberId: string }>;
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

  const parsed = updateMemberRoleSchema.safeParse(body);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Invalid request.";
    return Response.json({ error: { code: "VALIDATION_ERROR", message } }, { status: 400 });
  }

  const { slug, memberId } = await context.params;

  try {
    const result = await updateMemberRole(
      slug,
      session.user.id,
      session.user.isGlobalAdmin,
      memberId,
      parsed.data
    );

    if (!result.success) {
      switch (result.code) {
        case "NOT_FOUND":
          return Response.json(
            { error: { code: "NOT_FOUND", message: "Company or member not found." } },
            { status: 404 }
          );
        case "FORBIDDEN":
          return Response.json(
            {
              error: { code: "FORBIDDEN", message: "Only company owners can change member roles." },
            },
            { status: 403 }
          );
        case "CANNOT_CHANGE_OWN_ROLE":
          return Response.json(
            {
              error: {
                code: "CANNOT_CHANGE_OWN_ROLE",
                message: "You cannot change your own role.",
              },
            },
            { status: 400 }
          );
      }
    }

    return Response.json({ member: result.member });
  } catch {
    return Response.json(
      { error: { code: "INTERNAL_SERVER_ERROR", message: "Unexpected server error." } },
      { status: 500 }
    );
  }
}

export async function DELETE(_req: Request, context: Context) {
  const session = await auth();
  if (!session) {
    return Response.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication required." } },
      { status: 401 }
    );
  }

  const { slug, memberId } = await context.params;

  try {
    const result = await removeMember(slug, session.user.id, session.user.isGlobalAdmin, memberId);

    if (!result.success) {
      switch (result.code) {
        case "NOT_FOUND":
          return Response.json(
            { error: { code: "NOT_FOUND", message: "Company or member not found." } },
            { status: 404 }
          );
        case "FORBIDDEN":
          return Response.json(
            { error: { code: "FORBIDDEN", message: "Only company owners can remove members." } },
            { status: 403 }
          );
        case "CANNOT_REMOVE_SELF":
          return Response.json(
            {
              error: {
                code: "CANNOT_REMOVE_SELF",
                message: "You cannot remove yourself from the company.",
              },
            },
            { status: 400 }
          );
        case "CANNOT_REMOVE_LAST_OWNER":
          return Response.json(
            {
              error: {
                code: "CANNOT_REMOVE_LAST_OWNER",
                message: "Cannot remove the last owner of a company.",
              },
            },
            { status: 400 }
          );
      }
    }

    return Response.json({ success: true });
  } catch {
    return Response.json(
      { error: { code: "INTERNAL_SERVER_ERROR", message: "Unexpected server error." } },
      { status: 500 }
    );
  }
}
