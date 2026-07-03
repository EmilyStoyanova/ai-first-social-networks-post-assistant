"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { registerSchema } from "@/lib/validators/register.schema";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

type FieldErrors = { name?: string; email?: string; password?: string };

export function RegisterForm() {
  const router = useRouter();
  const t = useTranslations("auth.register");
  const tBrand = useTranslations("brand");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (isPending) return;

    const data = new FormData(e.currentTarget);
    const raw = {
      name: (data.get("name") as string) ?? "",
      email: (data.get("email") as string) ?? "",
      password: (data.get("password") as string) ?? "",
    };

    const parsed = registerSchema.safeParse(raw);
    if (!parsed.success) {
      const errs: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === "name") errs.name = issue.message;
        else if (field === "email") errs.email = issue.message;
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
      const res = await fetch("/api/v1/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });

      if (res.status === 409) {
        setFormError(t("emailExists"));
        return;
      }

      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        const message =
          body !== null &&
          typeof body === "object" &&
          "error" in body &&
          body.error !== null &&
          typeof body.error === "object" &&
          "message" in body.error &&
          typeof body.error.message === "string"
            ? body.error.message
            : t("error");
        setFormError(message);
        return;
      }

      router.push("/login?registered=1");
    } catch {
      setFormError(t("error"));
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

        <h1 className="mb-6 text-center text-lg font-semibold text-gray-800">{t("title")}</h1>

        <form onSubmit={handleSubmit} noValidate>
          {formError && (
            <Alert variant="error" className="mb-5">
              {formError}
            </Alert>
          )}

          <Input
            id="name"
            name="name"
            label={t("name")}
            type="text"
            autoComplete="name"
            autoFocus
            error={fieldErrors.name}
            className="mb-4"
          />

          <Input
            id="email"
            name="email"
            label={t("email")}
            type="email"
            autoComplete="email"
            error={fieldErrors.email}
            className="mb-4"
          />

          <Input
            id="password"
            name="password"
            label={t("password")}
            type="password"
            autoComplete="new-password"
            error={fieldErrors.password}
            className="mb-6"
          />

          <Button type="submit" size="lg" fullWidth loading={isPending}>
            {isPending ? t("creatingAccount") : t("createAccount")}
          </Button>
        </form>

        <div className="mt-6 border-t border-gray-100 pt-6 text-center text-sm text-gray-500">
          {t("hasAccount")}{" "}
          <Link href="/login" className="font-medium text-green-600 hover:underline">
            {t("signIn")}
          </Link>
        </div>
      </div>
    </div>
  );
}
