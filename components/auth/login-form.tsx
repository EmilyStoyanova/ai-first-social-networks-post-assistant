"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { extractApiError, useApiErrorMessage } from "@/lib/i18n/api-error";
import { loginSchema } from "@/lib/validators/login.schema";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

type FieldErrors = { email?: string; password?: string };

interface Props {
  registered?: boolean;
  callbackUrl?: string;
}

export function LoginForm({ registered = false, callbackUrl }: Props) {
  const router = useRouter();
  const t = useTranslations("auth.login");
  const tBrand = useTranslations("brand");
  const apiError = useApiErrorMessage();
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (isPending) return;

    const data = new FormData(e.currentTarget);
    const raw = {
      email: (data.get("email") as string) ?? "",
      password: (data.get("password") as string) ?? "",
    };

    const parsed = loginSchema.safeParse(raw);
    if (!parsed.success) {
      const errs: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === "email") errs.email = issue.message;
        else if (field === "password") errs.password = issue.message;
      }
      setFieldErrors(errs);
      setFormError(null);
      return;
    }

    setFieldErrors({});
    setFormError(null);
    setIsPending(true);

    try {
      const res = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });

      const body: unknown = await res.json();

      if (!res.ok) {
        setFormError(apiError(extractApiError(body), t("unexpectedError")));
        return;
      }

      router.push(callbackUrl ?? "/dashboard");
    } catch {
      setFormError(t("unexpectedError"));
    } finally {
      setIsPending(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-1 items-center justify-center bg-gray-50 px-4 py-12">
      <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white px-8 py-10 shadow-sm">
        {/* Brand */}
        <div className="mb-8 flex flex-col items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-green-500 shadow-sm">
            <span className="text-base font-bold text-white">AI</span>
          </div>
          <div className="text-center">
            <p className="text-base font-bold tracking-tight text-gray-900">{tBrand("title")}</p>
            <p className="text-sm text-gray-400">{tBrand("tagline")}</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} noValidate>
          {registered && (
            <Alert variant="success" className="mb-5">
              {t("accountCreated")}
            </Alert>
          )}

          {formError && (
            <Alert variant="error" className="mb-5">
              {formError}
            </Alert>
          )}

          <Input
            id="email"
            name="email"
            label={t("email")}
            type="email"
            autoComplete="email"
            autoFocus
            error={fieldErrors.email}
            className="mb-4"
          />

          <Input
            id="password"
            name="password"
            label={t("password")}
            type="password"
            autoComplete="current-password"
            error={fieldErrors.password}
            className="mb-6"
          />

          <Button type="submit" size="lg" fullWidth loading={isPending}>
            {isPending ? t("signingIn") : t("signIn")}
          </Button>

          <div className="mt-4 text-center">
            <button type="button" disabled className="cursor-not-allowed text-sm text-gray-400">
              {t("forgotPassword")}
            </button>
          </div>
        </form>

        <div className="mt-6 border-t border-gray-100 pt-6 text-center text-sm text-gray-500">
          {t("noAccount")}{" "}
          <Link href="/register" className="font-medium text-green-600 hover:underline">
            {t("register")}
          </Link>
        </div>
      </div>
    </div>
  );
}
