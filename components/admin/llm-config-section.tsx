"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/Card";
import { LlmConfigForm } from "./llm-config-form";
import { LlmConfigRow } from "./llm-config-row";

// ─── Shared type ──────────────────────────────────────────────────────────────

export type ClientLlmConfig = {
  id: string;
  provider: "CLAUDE" | "OPENAI" | "GROK" | "TEXT_WORKER";
  model: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  initialConfigs: ClientLlmConfig[];
}

export function LlmConfigSection({ initialConfigs }: Props) {
  const t = useTranslations("admin");
  const [configs, setConfigs] = useState<ClientLlmConfig[]>(initialConfigs);

  function handleCreated(config: ClientLlmConfig) {
    setConfigs((prev) => {
      const base = config.isActive ? prev.map((c) => ({ ...c, isActive: false })) : prev;
      return [...base, config];
    });
  }

  function handleUpdated(updated: ClientLlmConfig) {
    setConfigs((prev) =>
      prev.map((c) => {
        if (c.id === updated.id) return updated;
        return updated.isActive ? { ...c, isActive: false } : c;
      })
    );
  }

  function handleDeleted(id: string) {
    setConfigs((prev) => prev.filter((c) => c.id !== id));
  }

  return (
    <Card className="px-6 py-6">
      {/* Header */}
      <div className="mb-5">
        <h2 className="text-fg text-sm font-semibold">{t("llmProviders")}</h2>
      </div>

      {/* Add Provider */}
      <div className="mb-5">
        <h3 className="text-micro text-fg-faint mb-3">{t("addProvider")}</h3>
        <LlmConfigForm onSaved={handleCreated} />
      </div>

      <hr className="border-border mb-5" />

      {/* Configured Providers */}
      <div>
        <h3 className="text-micro text-fg-faint mb-3">{t("configuredProviders")}</h3>

        {configs.length === 0 ? (
          <p className="text-fg-faint py-4 text-center text-sm">{t("noProviders")}</p>
        ) : (
          <div className="divide-border divide-y">
            {configs.map((config) => (
              <LlmConfigRow
                key={config.id}
                config={config}
                onUpdated={handleUpdated}
                onDeleted={handleDeleted}
              />
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
