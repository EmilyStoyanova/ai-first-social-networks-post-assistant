"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useApiErrorMessage } from "@/lib/i18n/api-error";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { LlmConfigForm } from "./llm-config-form";
import type { ClientLlmConfig } from "./llm-config-section";

// ─── Provider metadata ────────────────────────────────────────────────────────

// Icons removed per §6.8 — no brand icons in Lucide; label carries meaning.
const PROVIDER_META: Record<string, { label: string }> = {
  CLAUDE: { label: "Claude" },
  OPENAI: { label: "OpenAI" },
  GROK: { label: "Grok" },
  TEXT_WORKER: { label: "Text Worker" },
};

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  config: ClientLlmConfig;
  onUpdated: (config: ClientLlmConfig) => void;
  onDeleted: (id: string) => void;
}

export function LlmConfigRow({ config, onUpdated, onDeleted }: Props) {
  const t = useTranslations("admin");
  const tCommon = useTranslations("common");
  const apiError = useApiErrorMessage();
  const [isEditing, setIsEditing] = useState(false);
  const [isActivating, setIsActivating] = useState(false);
  const [activateError, setActivateError] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const meta = PROVIDER_META[config.provider] ?? { label: config.provider };

  async function handleActivate() {
    setIsActivating(true);
    setActivateError("");
    try {
      const res = await fetch(`/api/v1/admin/llm-configs/${config.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: true }),
      });
      const json = (await res.json()) as {
        config?: ClientLlmConfig;
        error?: { message?: string };
      };
      if (!res.ok) throw new Error(apiError(json.error, t("activateError")));
      onUpdated(json.config!);
    } catch (err) {
      setActivateError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setIsActivating(false);
    }
  }

  async function handleDelete() {
    setIsDeleting(true);
    setDeleteError("");
    try {
      const res = await fetch(`/api/v1/admin/llm-configs/${config.id}`, { method: "DELETE" });
      if (res.status === 204) {
        onDeleted(config.id);
        return;
      }
      const json = (await res.json()) as { error?: { message?: string } };
      throw new Error(apiError(json.error, t("deleteError")));
    } catch (err) {
      setIsDeleting(false);
      setShowDeleteConfirm(false);
      setDeleteError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    }
  }

  // ── Edit mode ───────────────────────────────────────────────────────────────

  if (isEditing) {
    return (
      <div className="py-4">
        <div className="mb-3 flex items-center gap-2">
          <span className="text-fg text-sm font-semibold">{meta.label}</span>
        </div>
        <LlmConfigForm
          config={config}
          onSaved={(updated) => {
            onUpdated(updated);
            setIsEditing(false);
          }}
          onCancel={() => setIsEditing(false)}
        />
      </div>
    );
  }

  // ── Display mode ────────────────────────────────────────────────────────────

  return (
    <div className="py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Provider info */}
        <div className="flex min-w-0 items-center gap-3">
          <div className="min-w-0">
            <p className="text-fg text-sm font-semibold">{meta.label}</p>
            <p className="text-fg-muted mt-0.5 truncate text-xs">{config.model}</p>
          </div>
        </div>

        {/* Status + Actions */}
        <div className="flex flex-wrap items-center gap-2">
          {config.isActive ? (
            <Badge variant="success">{t("activeLlm")}</Badge>
          ) : (
            <Badge variant="neutral">{t("inactiveLlm")}</Badge>
          )}

          {!config.isActive && (
            <Button size="sm" variant="ghost" onClick={handleActivate} disabled={isActivating}>
              {isActivating ? t("activating") : t("setActive")}
            </Button>
          )}

          <Button size="sm" variant="ghost" onClick={() => setIsEditing(true)}>
            {tCommon("edit")}
          </Button>

          {!config.isActive &&
            (showDeleteConfirm ? (
              <>
                <span className="text-fg-muted text-xs">{t("deleteProvider")}</span>
                <Button size="sm" variant="danger" onClick={handleDelete} disabled={isDeleting}>
                  {isDeleting ? tCommon("deleting") : tCommon("confirm")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowDeleteConfirm(false)}
                  disabled={isDeleting}
                >
                  {tCommon("cancel")}
                </Button>
              </>
            ) : (
              <Button size="sm" variant="danger" onClick={() => setShowDeleteConfirm(true)}>
                {tCommon("delete")}
              </Button>
            ))}
        </div>
      </div>

      {/* Inline errors */}
      {activateError && (
        <Alert variant="error" className="mt-3">
          {activateError}
        </Alert>
      )}
      {deleteError && (
        <Alert variant="error" className="mt-3">
          {deleteError}
        </Alert>
      )}
    </div>
  );
}
