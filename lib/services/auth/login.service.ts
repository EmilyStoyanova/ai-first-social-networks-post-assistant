import { signIn } from "@/lib/auth";
import type { LoginInput } from "@/lib/validators/login.schema";

type LoginSuccess = { success: true };
type LoginFailure = { success: false; code: "INVALID_CREDENTIALS" };

export type LoginResult = LoginSuccess | LoginFailure;

export async function loginUser(data: LoginInput): Promise<LoginResult> {
  const email = data.email.trim().toLowerCase();

  // Auth.js signIn with redirect:false returns a URL string instead of redirecting.
  // An `error` search param in the returned URL signals a credential failure.
  const redirectUrl: unknown = await signIn("credentials", {
    email,
    password: data.password,
    redirect: false,
  });

  if (typeof redirectUrl === "string") {
    const parsed = new URL(redirectUrl, "http://localhost");
    if (parsed.searchParams.has("error")) {
      return { success: false, code: "INVALID_CREDENTIALS" };
    }
  }

  return { success: true };
}
