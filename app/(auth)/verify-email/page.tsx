import type { Metadata } from "next";
import { VerifyEmailCard } from "@/components/auth/verify-email-card";

export const metadata: Metadata = {
  title: "Verify Email – AI-First Post Assistant",
};

interface Props {
  searchParams: Promise<{ token?: string }>;
}

export default async function VerifyEmailPage({ searchParams }: Props) {
  const { token } = await searchParams;
  return <VerifyEmailCard token={token ?? ""} />;
}
