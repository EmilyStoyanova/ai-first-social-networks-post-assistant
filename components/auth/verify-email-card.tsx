"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";

interface Props {
  token: string;
}

export function VerifyEmailCard({ token }: Props) {
  const router = useRouter();
  const t = useTranslations("auth.verifyEmail");
  const tBrand = useTranslations("brand");
  const [status, setStatus] = useState<"idle" | "loading" | "invalid" | "expired">("idle");

  if (!token) {
    return (
      <div className="bg-bg flex min-h-screen flex-1 items-center justify-center px-4 py-12">
        <div className="rounded-card border-border bg-surface w-full max-w-md border px-5 py-8 shadow-sm sm:px-8 sm:py-10">
          <Alert variant="error">{t("invalidToken")}</Alert>
          <div className="mt-6 text-center text-sm">
            <Link href="/login" className="text-accent font-medium hover:underline">
              {t("backToLogin")}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  async function handleConfirm() {
    if (status === "loading") return;
    setStatus("loading");

    try {
      const res = await fetch("/api/v1/auth/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });

      if (res.ok) {
        router.push("/login?verified=1");
        return;
      }

      const body = await res.json().catch(() => null);
      const code = (body as { error?: { code?: string } } | null)?.error?.code;
      setStatus(code === "TOKEN_EXPIRED" ? "expired" : "invalid");
    } catch {
      setStatus("invalid");
    }
  }

  return (
    <div className="bg-bg flex min-h-screen flex-1 items-center justify-center px-4 py-12">
      <div className="rounded-card border-border bg-surface w-full max-w-md border px-5 py-8 shadow-sm sm:px-8 sm:py-10">
        <div className="mb-8 flex flex-col items-center gap-3">
          <div className="rounded-card bg-fg flex h-11 w-11 items-center justify-center shadow-sm">
            <span className="text-base font-bold text-white">AI</span>
          </div>
          <div className="text-center">
            <p className="text-fg text-base font-bold tracking-tight">{tBrand("title")}</p>
            <p className="text-fg-faint text-sm">{tBrand("tagline")}</p>
          </div>
        </div>

        {status === "invalid" && (
          <Alert variant="error" className="mb-5">
            {t("invalidToken")}
          </Alert>
        )}

        {status === "expired" && (
          <Alert variant="error" className="mb-5">
            {t("tokenExpired")}
          </Alert>
        )}

        {status !== "invalid" && status !== "expired" && (
          <>
            <p className="text-fg-muted mb-6 text-center text-sm">{t("description")}</p>
            <Button
              type="button"
              size="lg"
              fullWidth
              loading={status === "loading"}
              onClick={handleConfirm}
            >
              {status === "loading" ? t("confirming") : t("confirm")}
            </Button>
          </>
        )}

        <div className="border-border text-fg-muted mt-6 border-t pt-6 text-center text-sm">
          <Link href="/login" className="text-accent font-medium hover:underline">
            {t("backToLogin")}
          </Link>
        </div>
      </div>
    </div>
  );
}
