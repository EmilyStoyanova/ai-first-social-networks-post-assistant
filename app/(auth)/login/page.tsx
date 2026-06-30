import type { Metadata } from "next";
import { LoginForm } from "@/components/auth/login-form";

export const metadata: Metadata = {
  title: "Login – AI-First Post Assistant",
};

interface Props {
  searchParams: Promise<{ registered?: string }>;
}

export default async function LoginPage({ searchParams }: Props) {
  const { registered } = await searchParams;
  return <LoginForm registered={registered === "1"} />;
}
