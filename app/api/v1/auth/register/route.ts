import { registerSchema } from "@/lib/validators/register.schema";
import { registerUser } from "@/lib/services/auth/register.service";

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: { code: "INVALID_JSON", message: "Request body must be valid JSON." } },
      { status: 400 }
    );
  }

  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Invalid request.";
    return Response.json({ error: { code: "VALIDATION_ERROR", message } }, { status: 400 });
  }

  try {
    const result = await registerUser(parsed.data);

    if (!result.success) {
      return Response.json(
        { error: { code: "EMAIL_ALREADY_EXISTS", message: "Email already registered." } },
        { status: 409 }
      );
    }

    return Response.json(result.user, { status: 201 });
  } catch {
    return Response.json(
      { error: { code: "INTERNAL_SERVER_ERROR", message: "Unexpected server error." } },
      { status: 500 }
    );
  }
}
