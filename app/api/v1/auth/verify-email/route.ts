import { NextResponse } from "next/server";
import { verifyEmail } from "@/lib/services/auth/verify-email.service";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get("token");

  if (!token || typeof token !== "string" || token.length < 32) {
    return NextResponse.redirect(new URL("/login?error=invalid_token", request.url));
  }

  // Redirect to the confirmation page — do NOT consume the token here.
  // Email security scanners (Gmail, Outlook, etc.) follow GET links; the actual
  // token consumption is triggered by a user-initiated POST from the confirmation page.
  const dest = new URL("/verify-email", request.url);
  dest.searchParams.set("token", token);
  return NextResponse.redirect(dest);
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: { code: "INVALID_JSON" } }, { status: 400 });
  }

  const token = (body as Record<string, unknown>)?.token;
  if (!token || typeof token !== "string" || token.length < 32) {
    return Response.json({ error: { code: "INVALID_TOKEN" } }, { status: 400 });
  }

  try {
    const result = await verifyEmail(token);
    if (!result.success) {
      return Response.json(
        { error: { code: result.code === "TOKEN_EXPIRED" ? "TOKEN_EXPIRED" : "INVALID_TOKEN" } },
        { status: 400 }
      );
    }
    return Response.json({ success: true });
  } catch {
    return Response.json({ error: { code: "INTERNAL_SERVER_ERROR" } }, { status: 500 });
  }
}
