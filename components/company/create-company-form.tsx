"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createCompanySchema } from "@/lib/validators/company.schema";

type FieldErrors = { name?: string; website?: string };

export function CreateCompanyForm() {
  const router = useRouter();
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (isPending) return;

    const data = new FormData(e.currentTarget);
    const websiteRaw = (data.get("website") as string).trim();
    const raw = {
      name: (data.get("name") as string) ?? "",
      website: websiteRaw || undefined,
    };

    const parsed = createCompanySchema.safeParse(raw);
    if (!parsed.success) {
      const errs: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === "name") errs.name = issue.message;
        else if (field === "website") errs.website = issue.message;
      }
      setFieldErrors(errs);
      setFormError(null);
      return;
    }

    setFieldErrors({});
    setFormError(null);
    setIsPending(true);

    try {
      const res = await fetch("/api/v1/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });

      const body: unknown = await res.json();
      if (!res.ok) {
        const message =
          body !== null &&
          typeof body === "object" &&
          "error" in body &&
          body.error !== null &&
          typeof body.error === "object" &&
          "message" in body.error &&
          typeof body.error.message === "string"
            ? body.error.message
            : "Unexpected server error.";
        setFormError(message);
        return;
      }

      router.push("/companies");
    } catch {
      setFormError("Unexpected server error.");
    } finally {
      setIsPending(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg rounded-2xl border border-gray-200 bg-white px-8 py-10 shadow-sm">
      <h1 className="mb-8 text-xl font-bold tracking-tight text-gray-900">New Company</h1>

      <form onSubmit={handleSubmit} noValidate>
        {formError && (
          <div
            role="alert"
            className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
          >
            {formError}
          </div>
        )}

        {/* Company name */}
        <div className="mb-4">
          <label htmlFor="name" className="mb-1.5 block text-sm font-medium text-gray-700">
            Company name
          </label>
          <input
            id="name"
            name="name"
            type="text"
            autoComplete="organization"
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

        {/* Website */}
        <div className="mb-8">
          <label htmlFor="website" className="mb-1.5 block text-sm font-medium text-gray-700">
            Website <span className="font-normal text-gray-400">(optional)</span>
          </label>
          <input
            id="website"
            name="website"
            type="url"
            autoComplete="url"
            placeholder="https://example.com"
            aria-invalid={fieldErrors.website ? true : undefined}
            aria-describedby={fieldErrors.website ? "website-error" : "website-hint"}
            className={[
              "w-full rounded-lg border px-3 py-2 text-sm transition-colors outline-none",
              "focus:ring-2 focus:ring-offset-0",
              fieldErrors.website
                ? "border-red-400 bg-red-50 focus:border-red-500 focus:ring-red-200"
                : "border-gray-300 bg-white focus:border-blue-500 focus:ring-blue-100",
            ].join(" ")}
          />
          {fieldErrors.website ? (
            <p id="website-error" className="mt-1.5 text-xs text-red-600">
              {fieldErrors.website}
            </p>
          ) : (
            <p id="website-hint" className="mt-1.5 text-xs text-gray-400">
              Include https://
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={isPending}
            className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isPending ? "Creating…" : "Create Company"}
          </button>
          <Link
            href="/companies"
            className="rounded-lg px-5 py-2.5 text-sm font-semibold text-gray-600 transition-colors hover:bg-gray-100"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
