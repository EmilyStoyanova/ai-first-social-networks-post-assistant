"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/Card";
import { LlmConfigRow } from "./llm-config-row";

// ─── Shared type ──────────────────────────────────────────────────────────────

export type ProviderStatus = "available" | "misconfigured" | "not_configured";

export type ClientLlmProvider = {
  provider: "claude" | "openai" | "grok" | "text_worker";
  displayName: string;
  model: string;
  status: ProviderStatus;
  isActive: boolean;
  isDefault: boolean;
};

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  initialProviders: ClientLlmProvider[];
}

export function LlmConfigSection({ initialProviders }: Props) {
  const t = useTranslations("admin");
  const [providers, setProviders] = useState<ClientLlmProvider[]>(initialProviders);

  // Activation is not exclusive; only the default is. When a provider becomes the
  // default, clear the flag on every other provider so the UI stays consistent.
  function handleUpdated(updated: ClientLlmProvider) {
    setProviders((prev) =>
      prev.map((p) => {
        if (p.provider === updated.provider) return updated;
        return updated.isDefault ? { ...p, isDefault: false } : p;
      })
    );
  }

  return (
    <Card className="px-6 py-6">
      <div className="mb-2">
        <h2 className="text-fg text-sm font-semibold">{t("llmProviders")}</h2>
        <p className="text-fg-muted mt-1 text-sm">{t("providersHint")}</p>
      </div>

      <div className="divide-border divide-y">
        {providers.map((provider) => (
          <LlmConfigRow key={provider.provider} provider={provider} onUpdated={handleUpdated} />
        ))}
      </div>
    </Card>
  );
}
