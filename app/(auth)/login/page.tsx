import type { Metadata } from "next";
import { LoginForm } from "@/components/auth/login-form";

export const metadata: Metadata = {
  title: "Login – AI-First Post Assistant",
};

interface Props {
  searchParams: Promise<{
    registered?: string;
    verified?: string;
    error?: string;
    callbackUrl?: string;
  }>;
}

function sanitizeCallbackUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (!raw.startsWith("/") || raw.startsWith("//")) return undefined;
  return raw;
}

function parseTokenError(error: string | undefined): "token_expired" | "invalid_token" | undefined {
  if (error === "token_expired") return "token_expired";
  if (error === "invalid_token") return "invalid_token";
  return undefined;
}

export default async function LoginPage({ searchParams }: Props) {
  const { registered, verified, error, callbackUrl } = await searchParams;
  return (
    <LoginForm
      registered={registered === "1"}
      verified={verified === "1"}
      tokenError={parseTokenError(error)}
      callbackUrl={sanitizeCallbackUrl(callbackUrl)}
    />
  );
}
