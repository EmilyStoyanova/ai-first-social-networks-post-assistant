import { AuthError } from "next-auth";
import { signIn } from "@/lib/auth";
import type { LoginInput } from "@/lib/validators/login.schema";

type LoginSuccess = { success: true };
type LoginFailure = { success: false; code: "INVALID_CREDENTIALS" };

export type LoginResult = LoginSuccess | LoginFailure;

export async function loginUser(data: LoginInput): Promise<LoginResult> {
  const email = data.email.trim().toLowerCase();

  try {
    await signIn("credentials", {
      email,
      password: data.password,
      redirect: false,
    });
  } catch (error) {
    // Auth.js throws CredentialsSignin (an AuthError subclass) when authorize()
    // returns null — this happens even with redirect:false, not a URL return.
    if (error instanceof AuthError) {
      return { success: false, code: "INVALID_CREDENTIALS" };
    }
    throw error;
  }

  return { success: true };
}
