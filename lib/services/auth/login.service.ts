import { AuthError } from "next-auth";
import { signIn } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import type { LoginInput } from "@/lib/validators/login.schema";

type LoginSuccess = { success: true };
type LoginFailure = { success: false; code: "INVALID_CREDENTIALS" | "EMAIL_NOT_VERIFIED" };

export type LoginResult = LoginSuccess | LoginFailure;

export async function loginUser(data: LoginInput): Promise<LoginResult> {
  const email = data.email.trim().toLowerCase();

  // Pre-check: catch unverified emails before Auth.js collapses all failures
  // to the same INVALID_CREDENTIALS code.
  const user = await prisma.user.findUnique({
    where: { email },
    select: { emailVerified: true },
  });

  if (user && !user.emailVerified) {
    return { success: false, code: "EMAIL_NOT_VERIFIED" };
  }

  try {
    await signIn("credentials", {
      email,
      password: data.password,
      redirect: false,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return { success: false, code: "INVALID_CREDENTIALS" };
    }
    throw error;
  }

  return { success: true };
}
