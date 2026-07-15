"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useApiErrorMessage } from "@/lib/i18n/api-error";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import type { ClientLlmConfig } from "./llm-config-section";

// ─── Styling ──────────────────────────────────────────────────────────────────

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

// ─── Model placeholder per provider ──────────────────────────────────────────

const MODEL_PLACEHOLDER: Record<string, string> = {
  CLAUDE: "claude-sonnet-4-6",
  OPENAI: "gpt-4o",
  GROK: "grok-4",
  TEXT_WORKER: "qwen3:8b",
};

type ProviderValue = "CLAUDE" | "OPENAI" | "GROK" | "TEXT_WORKER";

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  /** Provide for edit mode; omit for create mode. */
  config?: ClientLlmConfig;
  onSaved: (config: ClientLlmConfig) => void;
  onCancel?: () => void;
}

export function LlmConfigForm({ config, onSaved, onCancel }: Props) {
  const t = useTranslations("admin");
  const tCommon = useTranslations("common");
  const apiError = useApiErrorMessage();
  const isEdit = config !== undefined;

  const [provider, setProvider] = useState<ProviderValue>(config?.provider ?? "CLAUDE");
  const [model, setModel] = useState(config?.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [isActive, setIsActive] = useState(config?.isActive ?? false);

  const [status, setStatus] = useState<"idle" | "submitting" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [modelError, setModelError] = useState("");
  const [apiKeyError, setApiKeyError] = useState("");

  const isSubmitting = status === "submitting";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setModelError("");
    setApiKeyError("");

    let hasError = false;
    if (!model.trim()) {
      setModelError(t("modelRequired"));
      hasError = true;
    }
    if (!isEdit && !apiKey.trim()) {
      setApiKeyError(t("apiKeyRequired"));
      hasError = true;
    }
    if (hasError) return;

    setStatus("submitting");
    setErrorMessage("");

    try {
      const body: Record<string, unknown> = { model: model.trim(), isActive };
      if (!isEdit) {
        body.provider = provider;
        body.apiKey = apiKey.trim();
      } else if (apiKey.trim()) {
        body.apiKey = apiKey.trim();
      }

      const url = isEdit ? `/api/v1/admin/llm-configs/${config.id}` : "/api/v1/admin/llm-configs";

      const res = await fetch(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const json = (await res.json()) as {
        config?: ClientLlmConfig;
        error?: { code?: string; message?: string };
      };

      if (!res.ok) throw new Error(apiError(json.error, t("saveConfigError")));

      onSaved(json.config!);

      if (!isEdit) {
        setProvider("CLAUDE");
        setModel("");
        setApiKey("");
        setIsActive(false);
      } else {
        onCancel?.();
      }
      setStatus("idle");
    } catch (err) {
      setStatus("error");
      setErrorMessage(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      {status === "error" && (
        <Alert variant="error" className="mb-3">
          {errorMessage}
        </Alert>
      )}

      <div className="flex flex-wrap items-end gap-3">
        {/* Provider selector — create mode only */}
        {!isEdit && (
          <div className="w-40 shrink-0">
            <label className="text-fg-muted mb-1.5 block text-sm font-medium">
              {t("provider")}
            </label>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as ProviderValue)}
              disabled={isSubmitting}
              className={fieldCls(false, isSubmitting)}
            >
              <option value="CLAUDE">Claude</option>
              <option value="OPENAI">OpenAI</option>
              <option value="GROK">Grok</option>
              <option value="TEXT_WORKER">Text Worker</option>
            </select>
          </div>
        )}

        {/* Model */}
        <div className="min-w-[10rem] flex-1">
          <label className="text-fg-muted mb-1.5 block text-sm font-medium">{t("model")}</label>
          <input
            type="text"
            placeholder={MODEL_PLACEHOLDER[provider] ?? "model-name"}
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              if (modelError) setModelError("");
              if (status !== "idle") setStatus("idle");
            }}
            disabled={isSubmitting}
            className={fieldCls(!!modelError, isSubmitting)}
          />
          {modelError && <p className="text-status-danger-fg mt-1 text-xs">{modelError}</p>}
        </div>

        {/* API Key */}
        <div className="min-w-[12rem] flex-1">
          <label className="text-fg-muted mb-1.5 block text-sm font-medium">{t("apiKey")}</label>
          <input
            type="password"
            placeholder={isEdit ? t("apiKeyHint") : "sk-…"}
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              if (apiKeyError) setApiKeyError("");
              if (status !== "idle") setStatus("idle");
            }}
            disabled={isSubmitting}
            autoComplete="new-password"
            className={fieldCls(!!apiKeyError, isSubmitting)}
          />
          {apiKeyError && <p className="text-status-danger-fg mt-1 text-xs">{apiKeyError}</p>}
        </div>

        {/* Active checkbox */}
        <div className="shrink-0 pb-3">
          <label className="text-fg-muted flex cursor-pointer items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              disabled={isSubmitting}
              className="border-border-strong text-status-success-fg focus:ring-accent h-4 w-4 rounded"
            />
            {t("active")}
          </label>
        </div>

        {/* Submit + Cancel */}
        <div className="flex shrink-0 items-center gap-2 pb-0.5">
          <Button type="submit" variant="primary" disabled={isSubmitting} loading={isSubmitting}>
            {isSubmitting ? tCommon("saving") : t("saveShort")}
          </Button>
          {isEdit && onCancel && (
            <Button type="button" variant="ghost" onClick={onCancel} disabled={isSubmitting}>
              {tCommon("cancel")}
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}
