import NextAuth from "next-auth";
import { NextResponse } from "next/server";

// Minimal NextAuth instance — no Prisma, no bcrypt.
// Shares AUTH_SECRET with lib/auth so it can verify the same JWT session cookies.
const { auth } = NextAuth({
  session: { strategy: "jwt" },
  providers: [],
});

const PROTECTED_PREFIXES = [
  "/dashboard",
  "/companies",
  "/admin",
  "/create",
  "/competitive-analysis",
] as const;
const AUTH_PAGES = ["/login", "/register"] as const;

function matchesProtected(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

function matchesAuthPage(pathname: string): boolean {
  return AUTH_PAGES.some((page) => pathname === page || pathname.startsWith(`${page}/`));
}

// auth() wraps this as NextAuthMiddleware — TypeScript infers req as NextAuthRequest
// which adds req.auth: Session | null on top of NextRequest.
export default auth(function proxy(req) {
  const { pathname, search } = req.nextUrl;
  const isLoggedIn = !!req.auth;

  // Authenticated users have no reason to be on login/register — send them home.
  if (isLoggedIn && matchesAuthPage(pathname)) {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }

  // Protected routes require a session; preserve the original destination as callbackUrl.
  if (!isLoggedIn && matchesProtected(pathname)) {
    const callbackUrl = pathname + search;
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("callbackUrl", callbackUrl);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    // Run on all routes except Next.js internals and files with static extensions.
    "/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|woff|woff2)).*)",
  ],
};
