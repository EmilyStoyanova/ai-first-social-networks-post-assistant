"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useApiErrorMessage } from "@/lib/i18n/api-error";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ColorField } from "@/components/ui/ColorField";
import { updateBrandGuidelinesSchema } from "@/lib/validators/brand-guidelines.schema";
import type { BrandGuidelinesData } from "@/lib/services/company/update-brand-guidelines.service";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  slug: string;
  initialValues: BrandGuidelinesData | null;
  role: "OWNER" | "EDITOR" | null;
  isGlobalAdmin: boolean;
}

type FormValues = {
  logoUrl: string;
  primaryColor: string;
  secondaryColor: string;
  fontFamily: string;
  toneOfVoice: string;
  companyDescription: string;
  targetAudience: string;
  forbiddenWords: string;
  competitors: string;
};

type FieldErrors = Partial<Record<keyof FormValues, string>>;

// ─── Converters ───────────────────────────────────────────────────────────────

function toFormValues(data: BrandGuidelinesData | null): FormValues {
  return {
    logoUrl: data?.logoUrl ?? "",
    primaryColor: data?.primaryColor ?? "",
    secondaryColor: data?.secondaryColor ?? "",
    fontFamily: data?.fontFamily ?? "",
    toneOfVoice: data?.toneOfVoice ?? "",
    companyDescription: data?.companyDescription ?? "",
    targetAudience: data?.targetAudience ?? "",
    forbiddenWords: data?.forbiddenWords.join("\n") ?? "",
    competitors: data?.competitors.join("\n") ?? "",
  };
}

function toApiPayload(values: FormValues) {
  const splitLines = (raw: string) =>
    raw
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

  return {
    logoUrl: values.logoUrl.trim() || undefined,
    primaryColor: values.primaryColor.trim() || undefined,
    secondaryColor: values.secondaryColor.trim() || undefined,
    fontFamily: values.fontFamily.trim() || undefined,
    toneOfVoice: values.toneOfVoice.trim() || undefined,
    companyDescription: values.companyDescription.trim() || undefined,
    targetAudience: values.targetAudience.trim() || undefined,
    forbiddenWords: splitLines(values.forbiddenWords),
    competitors: splitLines(values.competitors),
  };
}

// ─── Styling helpers ─────────────────────────────────────────────────────────

const BASE_FIELD =
  "w-full rounded-lg border px-3.5 py-2.5 text-sm outline-none transition-all duration-200 focus:ring-2 focus:ring-offset-0";
const NORMAL_FIELD = "border-gray-300 bg-white focus:border-green-500 focus:ring-green-100";
const ERROR_FIELD = "border-red-400 bg-red-50 focus:border-red-500 focus:ring-red-200";
const DISABLED_FIELD = "cursor-not-allowed opacity-60";

function fieldCls(hasError: boolean, isDisabled: boolean): string {
  return [BASE_FIELD, hasError ? ERROR_FIELD : NORMAL_FIELD, isDisabled ? DISABLED_FIELD : ""]
    .filter(Boolean)
    .join(" ");
}

// ─── Internal layout helpers ──────────────────────────────────────────────────

function Label({ htmlFor, text }: { htmlFor: string; text: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium text-gray-700">
      {text}
    </label>
  );
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1.5 text-xs text-red-600">
      {message}
    </p>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function BrandGuidelinesForm({ slug, initialValues, role, isGlobalAdmin }: Props) {
  const t = useTranslations("brandGuidelines");
  const tCommon = useTranslations("common");
  const apiError = useApiErrorMessage();
  const canEdit = role === "OWNER" || isGlobalAdmin;

  const [values, setValues] = useState<FormValues>(() => toFormValues(initialValues));
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [status, setStatus] = useState<"idle" | "saving" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");

  const isSaving = status === "saving";
  const disabled = !canEdit || isSaving;

  function set(field: keyof FormValues, value: string) {
    setValues((prev) => ({ ...prev, [field]: value }));
    if (fieldErrors[field]) setFieldErrors((prev) => ({ ...prev, [field]: undefined }));
    if (status !== "idle") setStatus("idle");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const payload = toApiPayload(values);
    const parsed = updateBrandGuidelinesSchema.safeParse(payload);

    if (!parsed.success) {
      const errors: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof FormValues;
        if (!errors[key]) errors[key] = issue.message;
      }
      setFieldErrors(errors);
      return;
    }

    setStatus("saving");
    setFieldErrors({});

    try {
      const res = await fetch(`/api/v1/companies/${slug}/brand`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });

      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(apiError(json.error));
      }

      setStatus("success");
    } catch (err) {
      setStatus("error");
      setErrorMessage(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    }
  }

  return (
    <Card className="px-6 py-6">
      {/* Card header */}
      <div className="mb-5 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">{t("title")}</h2>
        {!canEdit && <Badge variant="neutral">{tCommon("readOnly")}</Badge>}
      </div>

      {/* Status alerts */}
      {status === "success" && (
        <Alert variant="success" className="mb-5">
          {t("savedSuccess")}
        </Alert>
      )}
      {status === "error" && (
        <Alert variant="error" className="mb-5">
          {errorMessage}
        </Alert>
      )}

      <form onSubmit={handleSubmit} noValidate>
        {/* Row: Logo URL + Font Family */}
        <div className="mb-4 grid gap-x-6 gap-y-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="bg-logoUrl" text={t("logoUrl")} />
            <input
              id="bg-logoUrl"
              name="logoUrl"
              type="url"
              placeholder="https://example.com/logo.png"
              value={values.logoUrl}
              onChange={(e) => set("logoUrl", e.target.value)}
              disabled={disabled}
              aria-invalid={fieldErrors.logoUrl ? true : undefined}
              aria-describedby={fieldErrors.logoUrl ? "bg-logoUrl-error" : undefined}
              className={fieldCls(!!fieldErrors.logoUrl, disabled)}
            />
            <FieldError id="bg-logoUrl-error" message={fieldErrors.logoUrl} />
          </div>

          <div>
            <Label htmlFor="bg-fontFamily" text={t("fontFamily")} />
            <input
              id="bg-fontFamily"
              name="fontFamily"
              type="text"
              placeholder="Inter, sans-serif"
              value={values.fontFamily}
              onChange={(e) => set("fontFamily", e.target.value)}
              disabled={disabled}
              aria-invalid={fieldErrors.fontFamily ? true : undefined}
              aria-describedby={fieldErrors.fontFamily ? "bg-fontFamily-error" : undefined}
              className={fieldCls(!!fieldErrors.fontFamily, disabled)}
            />
            <FieldError id="bg-fontFamily-error" message={fieldErrors.fontFamily} />
          </div>
        </div>

        {/* Row: Primary Color + Secondary Color */}
        <div className="mb-4 grid gap-x-6 gap-y-4 sm:grid-cols-2">
          <ColorField
            id="bg-primaryColor"
            label={t("primaryColor")}
            value={values.primaryColor}
            onChange={(v) => set("primaryColor", v)}
            error={fieldErrors.primaryColor}
            disabled={disabled}
          />
          <ColorField
            id="bg-secondaryColor"
            label={t("secondaryColor")}
            value={values.secondaryColor}
            onChange={(v) => set("secondaryColor", v)}
            error={fieldErrors.secondaryColor}
            disabled={disabled}
          />
        </div>

        {/* Tone of Voice */}
        <div className="mb-4">
          <Label htmlFor="bg-toneOfVoice" text={t("toneOfVoice")} />
          <textarea
            id="bg-toneOfVoice"
            name="toneOfVoice"
            rows={2}
            placeholder={t("toneOfVoicePlaceholder")}
            value={values.toneOfVoice}
            onChange={(e) => set("toneOfVoice", e.target.value)}
            disabled={disabled}
            aria-invalid={fieldErrors.toneOfVoice ? true : undefined}
            aria-describedby={fieldErrors.toneOfVoice ? "bg-toneOfVoice-error" : undefined}
            className={`${fieldCls(!!fieldErrors.toneOfVoice, disabled)} resize-none`}
          />
          <FieldError id="bg-toneOfVoice-error" message={fieldErrors.toneOfVoice} />
        </div>

        {/* Company Description */}
        <div className="mb-4">
          <Label htmlFor="bg-companyDescription" text={t("companyDescription")} />
          <textarea
            id="bg-companyDescription"
            name="companyDescription"
            rows={4}
            placeholder={t("companyDescriptionPlaceholder")}
            value={values.companyDescription}
            onChange={(e) => set("companyDescription", e.target.value)}
            disabled={disabled}
            aria-invalid={fieldErrors.companyDescription ? true : undefined}
            aria-describedby={
              fieldErrors.companyDescription ? "bg-companyDescription-error" : undefined
            }
            className={`${fieldCls(!!fieldErrors.companyDescription, disabled)} resize-none`}
          />
          <FieldError id="bg-companyDescription-error" message={fieldErrors.companyDescription} />
        </div>

        {/* Target Audience */}
        <div className="mb-4">
          <Label htmlFor="bg-targetAudience" text={t("targetAudience")} />
          <textarea
            id="bg-targetAudience"
            name="targetAudience"
            rows={3}
            placeholder={t("targetAudiencePlaceholder")}
            value={values.targetAudience}
            onChange={(e) => set("targetAudience", e.target.value)}
            disabled={disabled}
            aria-invalid={fieldErrors.targetAudience ? true : undefined}
            aria-describedby={fieldErrors.targetAudience ? "bg-targetAudience-error" : undefined}
            className={`${fieldCls(!!fieldErrors.targetAudience, disabled)} resize-none`}
          />
          <FieldError id="bg-targetAudience-error" message={fieldErrors.targetAudience} />
        </div>

        {/* Row: Forbidden Words + Competitors */}
        <div className="mb-6 grid gap-x-6 gap-y-4 sm:grid-cols-2">
          <div>
            <label
              htmlFor="bg-forbiddenWords"
              className="mb-1.5 block text-sm font-medium text-gray-700"
            >
              {t("forbiddenWords")}{" "}
              <span className="font-normal text-gray-400">{t("forbiddenWordsHint")}</span>
            </label>
            <textarea
              id="bg-forbiddenWords"
              name="forbiddenWords"
              rows={5}
              placeholder={"cheap\ndiscount\nfree\nurgent"}
              value={values.forbiddenWords}
              onChange={(e) => set("forbiddenWords", e.target.value)}
              disabled={disabled}
              aria-invalid={fieldErrors.forbiddenWords ? true : undefined}
              aria-describedby={fieldErrors.forbiddenWords ? "bg-forbiddenWords-error" : undefined}
              className={`${fieldCls(!!fieldErrors.forbiddenWords, disabled)} resize-none`}
            />
            <FieldError id="bg-forbiddenWords-error" message={fieldErrors.forbiddenWords} />
          </div>

          <div>
            <label
              htmlFor="bg-competitors"
              className="mb-1.5 block text-sm font-medium text-gray-700"
            >
              {t("competitors")}{" "}
              <span className="font-normal text-gray-400">{t("competitorsHint")}</span>
            </label>
            <textarea
              id="bg-competitors"
              name="competitors"
              rows={5}
              placeholder={"Competitor A\nCompetitor B\nCompetitor C"}
              value={values.competitors}
              onChange={(e) => set("competitors", e.target.value)}
              disabled={disabled}
              aria-invalid={fieldErrors.competitors ? true : undefined}
              aria-describedby={fieldErrors.competitors ? "bg-competitors-error" : undefined}
              className={`${fieldCls(!!fieldErrors.competitors, disabled)} resize-none`}
            />
            <FieldError id="bg-competitors-error" message={fieldErrors.competitors} />
          </div>
        </div>

        {/* Save button — owners and global admins only */}
        {canEdit && (
          <Button type="submit" variant="primary" disabled={isSaving}>
            {isSaving ? tCommon("saving") : tCommon("save")}
          </Button>
        )}
      </form>
    </Card>
  );
}
