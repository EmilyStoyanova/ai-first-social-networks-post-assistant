"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useApiErrorMessage } from "@/lib/i18n/api-error";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import type { ClientLlmProvider } from "./llm-config-section";

interface Props {
  provider: ClientLlmProvider;
  onUpdated: (provider: ClientLlmProvider) => void;
}

export function LlmConfigRow({ provider, onUpdated }: Props) {
  const t = useTranslations("admin");
  const tCommon = useTranslations("common");
  const apiError = useApiErrorMessage();
  const [isPatching, setIsPatching] = useState(false);
  const [patchError, setPatchError] = useState("");

  const available = provider.status === "available";

  // Shared PATCH for the activate / deactivate / set-default toggles. Credentials
  // are never involved — this only flips runtime state.
  async function patchState(body: Record<string, unknown>, errorKey: string) {
    setIsPatching(true);
    setPatchError("");
    try {
      const res = await fetch(`/api/v1/admin/llm-configs/${provider.provider}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as {
        provider?: ClientLlmProvider;
        error?: { message?: string };
      };
      if (!res.ok) throw new Error(apiError(json.error, t(errorKey)));
      onUpdated(json.provider!);
    } catch (err) {
      setPatchError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setIsPatching(false);
    }
  }

  const handleActivate = () => patchState({ isActive: true }, "activateError");
  const handleDeactivate = () => patchState({ isActive: false }, "deactivateError");
  const handleSetDefault = () => patchState({ isDefault: true }, "setDefaultError");

  const statusBadge = available ? (
    <Badge variant="success">{t("statusAvailable")}</Badge>
  ) : provider.status === "misconfigured" ? (
    <Badge variant="warning">{t("statusMisconfigured")}</Badge>
  ) : (
    <Badge variant="neutral">{t("statusNotConfigured")}</Badge>
  );

  return (
    <div className="py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Provider info */}
        <div className="flex min-w-0 items-center gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-fg text-sm font-semibold">{provider.displayName}</p>
              {provider.isDefault && <Badge variant="accent">{t("defaultLlm")}</Badge>}
            </div>
            <p className="text-fg-muted mt-0.5 truncate text-xs">{provider.model}</p>
          </div>
        </div>

        {/* Status + Actions */}
        <div className="flex flex-wrap items-center gap-2">
          {statusBadge}
          {provider.isActive ? (
            <Badge variant="success">{t("activeLlm")}</Badge>
          ) : (
            <Badge variant="neutral">{t("inactiveLlm")}</Badge>
          )}

          {/* Activate — only for an available, inactive provider. Unavailable
              providers show a hint instead: they can't be turned on. */}
          {!provider.isActive && available && (
            <Button size="sm" variant="ghost" onClick={handleActivate} disabled={isPatching}>
              {isPatching ? t("activating") : t("setActive")}
            </Button>
          )}
          {!provider.isActive && !available && (
            <span className="text-fg-faint text-xs">{t("cannotActivateHint")}</span>
          )}

          {/* Default is exclusive; only an active, non-default provider can be promoted. */}
          {provider.isActive && !provider.isDefault && (
            <Button size="sm" variant="ghost" onClick={handleSetDefault} disabled={isPatching}>
              {isPatching ? t("settingDefault") : t("setDefault")}
            </Button>
          )}

          {/* Deactivate an active, non-default provider. */}
          {provider.isActive && !provider.isDefault && (
            <Button size="sm" variant="ghost" onClick={handleDeactivate} disabled={isPatching}>
              {isPatching ? t("deactivating") : t("deactivate")}
            </Button>
          )}
        </div>
      </div>

      {patchError && (
        <Alert variant="error" className="mt-3">
          {patchError}
        </Alert>
      )}
    </div>
  );
}
