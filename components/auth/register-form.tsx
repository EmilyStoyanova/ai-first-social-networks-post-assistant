"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { registerSchema } from "@/lib/validators/register.schema";

type FieldErrors = { name?: string; email?: string; password?: string };

export function RegisterForm() {
  const router = useRouter();
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
        setFormError("An account with this email already exists.");
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
            : "Something went wrong. Please try again.";
        setFormError(message);
        return;
      }

      router.push("/login?registered=1");
    } catch {
      setFormError("Something went wrong. Please try again.");
    } finally {
      setIsPending(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-1 items-center justify-center bg-gray-50 px-4 py-12">
      <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white px-8 py-10 shadow-sm">
        <div className="mb-6 text-center">
          <div className="mb-1 text-2xl font-bold tracking-tight text-gray-900">
            AI-First Social Networks
          </div>
          <p className="text-sm text-gray-500">Post Assistant</p>
        </div>

        <h1 className="mb-6 text-center text-lg font-semibold text-gray-800">
          Create your account
        </h1>

        <form onSubmit={handleSubmit} noValidate>
          {formError && (
            <div
              role="alert"
              className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
            >
              {formError}
            </div>
          )}

          {/* Name */}
          <div className="mb-4">
            <label htmlFor="name" className="mb-1.5 block text-sm font-medium text-gray-700">
              Name
            </label>
            <input
              id="name"
              name="name"
              type="text"
              autoComplete="name"
              autoFocus
              aria-invalid={fieldErrors.name ? true : undefined}
              aria-describedby={fieldErrors.name ? "name-error" : undefined}
              className={[
                "w-full rounded-lg border px-3 py-2 text-sm transition-colors outline-none",
                "focus:ring-2 focus:ring-offset-0",
                fieldErrors.name
                  ? "border-red-400 bg-red-50 focus:border-red-500 focus:ring-red-200"
                  : "border-gray-300 bg-white focus:border-blue-500 focus:ring-blue-100",
              ].join(" ")}
            />
            {fieldErrors.name && (
              <p id="name-error" className="mt-1.5 text-xs text-red-600">
                {fieldErrors.name}
              </p>
            )}
          </div>

          {/* Email */}
          <div className="mb-4">
            <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-gray-700">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              aria-invalid={fieldErrors.email ? true : undefined}
              aria-describedby={fieldErrors.email ? "email-error" : undefined}
              className={[
                "w-full rounded-lg border px-3 py-2 text-sm transition-colors outline-none",
                "focus:ring-2 focus:ring-offset-0",
                fieldErrors.email
                  ? "border-red-400 bg-red-50 focus:border-red-500 focus:ring-red-200"
                  : "border-gray-300 bg-white focus:border-blue-500 focus:ring-blue-100",
              ].join(" ")}
            />
            {fieldErrors.email && (
              <p id="email-error" className="mt-1.5 text-xs text-red-600">
                {fieldErrors.email}
              </p>
            )}
          </div>

          {/* Password */}
          <div className="mb-6">
            <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-gray-700">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              aria-invalid={fieldErrors.password ? true : undefined}
              aria-describedby={fieldErrors.password ? "password-error" : undefined}
              className={[
                "w-full rounded-lg border px-3 py-2 text-sm transition-colors outline-none",
                "focus:ring-2 focus:ring-offset-0",
                fieldErrors.password
                  ? "border-red-400 bg-red-50 focus:border-red-500 focus:ring-red-200"
                  : "border-gray-300 bg-white focus:border-blue-500 focus:ring-blue-100",
              ].join(" ")}
            />
            {fieldErrors.password && (
              <p id="password-error" className="mt-1.5 text-xs text-red-600">
                {fieldErrors.password}
              </p>
            )}
          </div>

          <button
            type="submit"
            disabled={isPending}
            className="w-full rounded-lg bg-blue-600 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isPending ? "Creating account…" : "Create account"}
          </button>
        </form>

        <div className="mt-6 border-t border-gray-100 pt-6 text-center text-sm text-gray-500">
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-blue-600 hover:underline">
            Login
          </Link>
        </div>
      </div>
    </div>
  );
}
