import { NextResponse } from "next/server";
import { verifyEmail } from "@/lib/services/auth/verify-email.service";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get("token");

  if (!token || typeof token !== "string" || token.length < 32) {
    return NextResponse.redirect(new URL("/login?error=invalid_token", request.url));
  }

  try {
    const result = await verifyEmail(token);

    if (!result.success) {
      const param = result.code === "TOKEN_EXPIRED" ? "token_expired" : "invalid_token";
      return NextResponse.redirect(new URL(`/login?error=${param}`, request.url));
    }

    return NextResponse.redirect(new URL("/login?verified=1", request.url));
  } catch {
    return NextResponse.redirect(new URL("/login?error=invalid_token", request.url));
  }
}
