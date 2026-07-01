import type { Metadata } from "next";
import { LoginForm } from "@/components/auth/login-form";

export const metadata: Metadata = {
  title: "Login – AI-First Post Assistant",
};

interface Props {
  searchParams: Promise<{ registered?: string; callbackUrl?: string }>;
}

function sanitizeCallbackUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  // Reject absolute URLs (https://…) and protocol-relative URLs (//…).
  if (!raw.startsWith("/") || raw.startsWith("//")) return undefined;
  return raw;
}

export default async function LoginPage({ searchParams }: Props) {
  const { registered, callbackUrl } = await searchParams;
  return (
    <LoginForm registered={registered === "1"} callbackUrl={sanitizeCallbackUrl(callbackUrl)} />
  );
}
