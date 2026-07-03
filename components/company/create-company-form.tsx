"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { createCompanySchema } from "@/lib/validators/company.schema";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";

type FieldErrors = { name?: string; website?: string };

export function CreateCompanyForm() {
  const t = useTranslations("createCompany");
  const tCommon = useTranslations("common");
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
            : tCommon("somethingWentWrong");
        setFormError(message);
        return;
      }

      router.push("/companies");
    } catch {
      setFormError(tCommon("somethingWentWrong"));
    } finally {
      setIsPending(false);
    }
  }

  return (
    <Card className="mx-auto max-w-lg px-8 py-10">
      <h1 className="mb-8 text-xl font-bold tracking-tight text-gray-900">{t("heading")}</h1>

      <form onSubmit={handleSubmit} noValidate>
        {formError && (
          <Alert variant="error" className="mb-5">
            {formError}
          </Alert>
        )}

        <Input
          id="name"
          name="name"
          label={t("nameLabel")}
          type="text"
          autoComplete="organization"
          autoFocus
          error={fieldErrors.name}
          className="mb-4"
        />

        <Input
          id="website"
          name="website"
          label={t("website")}
          type="url"
          autoComplete="url"
          placeholder="https://example.com"
          error={fieldErrors.website}
          helperText={fieldErrors.website ? undefined : t("websiteHint")}
          className="mb-8"
        />

        <div className="flex items-center gap-3">
          <Button type="submit" size="lg" loading={isPending}>
            {isPending ? t("creating") : t("create")}
          </Button>
          <Button href="/companies" variant="ghost" size="lg">
            {tCommon("cancel")}
          </Button>
        </div>
      </form>
    </Card>
  );
}
