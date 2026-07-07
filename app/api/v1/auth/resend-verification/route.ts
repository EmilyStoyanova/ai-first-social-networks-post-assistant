import { z } from "zod";
import { resendVerificationEmail } from "@/lib/services/auth/resend-verification.service";

const schema = z.object({ email: z.string().email() });

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

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: { code: "VALIDATION_ERROR", message: "Invalid email address." } },
      { status: 400 }
    );
  }

  try {
    await resendVerificationEmail(parsed.data.email);
    // Always return 200 — never reveal whether the email exists or is verified
    return Response.json({ success: true });
  } catch {
    return Response.json(
      { error: { code: "INTERNAL_SERVER_ERROR", message: "Unexpected server error." } },
      { status: 500 }
    );
  }
}
