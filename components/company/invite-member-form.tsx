"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useApiErrorMessage } from "@/lib/i18n/api-error";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { inviteMemberSchema } from "@/lib/validators/company-member.schema";
import type { ClientMember } from "./company-members";

// ─── Styling helpers ──────────────────────────────────────────────────────────

const BASE_INPUT =
  "w-full rounded-control border px-3.5 py-2.5 text-sm outline-none transition-all duration-fast focus:ring-2 focus:ring-offset-0";
const NORMAL_INPUT = "border-border-strong bg-surface focus:border-accent focus:ring-accent/20";
const ERROR_INPUT =
  "border-status-danger-dot bg-status-danger-bg focus:border-status-danger-dot focus:ring-status-danger-dot/30";
const DISABLED_INPUT = "cursor-not-allowed opacity-60";

function fieldCls(hasError: boolean, isDisabled: boolean) {
  return [BASE_INPUT, hasError ? ERROR_INPUT : NORMAL_INPUT, isDisabled ? DISABLED_INPUT : ""]
    .filter(Boolean)
    .join(" ");
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  slug: string;
  onInvited: (member: ClientMember) => void;
}

export function InviteMemberForm({ slug, onInvited }: Props) {
  const t = useTranslations("members");
  const tCommon = useTranslations("common");
  const apiError = useApiErrorMessage();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"OWNER" | "EDITOR">("EDITOR");
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [emailError, setEmailError] = useState("");

  const isSubmitting = status === "submitting";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setEmailError("");

    const parsed = inviteMemberSchema.safeParse({ email: email.trim(), role });
    if (!parsed.success) {
      setEmailError(t("invalidEmail"));
      return;
    }

    setStatus("submitting");
    setErrorMessage("");

    try {
      const res = await fetch(`/api/v1/companies/${slug}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });

      const json = (await res.json()) as {
        member?: ClientMember;
        error?: { code?: string; message?: string };
      };

      if (!res.ok) {
        throw new Error(apiError(json.error, t("inviteError")));
      }

      onInvited(json.member!);
      setEmail("");
      setRole("EDITOR");
      setStatus("success");
      setTimeout(() => setStatus("idle"), 3000);
    } catch (err) {
      setStatus("error");
      setErrorMessage(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      {status === "success" && (
        <Alert variant="success" className="mb-3">
          {t("inviteSuccess")}
        </Alert>
      )}
      {status === "error" && (
        <Alert variant="error" className="mb-3">
          {errorMessage}
        </Alert>
      )}

      <div className="flex flex-wrap items-end gap-3">
        {/* Email */}
        <div className="min-w-[14rem] flex-1">
          <label htmlFor="invite-email" className="text-fg-muted mb-1.5 block text-sm font-medium">
            {t("email")}
          </label>
          <input
            id="invite-email"
            name="email"
            type="email"
            placeholder="colleague@example.com"
            autoComplete="off"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (emailError) setEmailError("");
              if (status !== "idle") setStatus("idle");
            }}
            disabled={isSubmitting}
            aria-invalid={emailError ? true : undefined}
            aria-describedby={emailError ? "invite-email-error" : undefined}
            className={fieldCls(!!emailError, isSubmitting)}
          />
          {emailError ? (
            <p id="invite-email-error" className="text-status-danger-fg mt-1.5 text-xs">
              {emailError}
            </p>
          ) : (
            <p className="text-fg-faint mt-1.5 text-xs">{t("inviteHint")}</p>
          )}
        </div>

        {/* Role */}
        <div className="w-36 shrink-0">
          <label htmlFor="invite-role" className="text-fg-muted mb-1.5 block text-sm font-medium">
            {t("role")}
          </label>
          <select
            id="invite-role"
            name="role"
            value={role}
            onChange={(e) => setRole(e.target.value as "OWNER" | "EDITOR")}
            disabled={isSubmitting}
            className={fieldCls(false, isSubmitting)}
          >
            <option value="EDITOR">{t("editor")}</option>
            <option value="OWNER">{t("owner")}</option>
          </select>
        </div>

        {/* Submit */}
        <div className="shrink-0 pb-0.5">
          <Button type="submit" variant="primary" disabled={isSubmitting} loading={isSubmitting}>
            {isSubmitting ? t("inviting") : t("invite")}
          </Button>
        </div>
      </div>
    </form>
  );
}
