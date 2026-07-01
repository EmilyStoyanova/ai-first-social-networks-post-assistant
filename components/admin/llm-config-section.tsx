"use client";

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { LlmConfigForm } from "./llm-config-form";
import { LlmConfigRow } from "./llm-config-row";

// ─── Shared type ──────────────────────────────────────────────────────────────

export type ClientLlmConfig = {
  id: string;
  provider: "CLAUDE" | "OPENAI" | "GROK";
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
        <h2 className="text-sm font-semibold text-gray-900">LLM Providers</h2>
      </div>

      {/* Add Provider */}
      <div className="mb-5">
        <h3 className="mb-3 text-xs font-semibold tracking-widest text-gray-400 uppercase">
          Add Provider
        </h3>
        <LlmConfigForm onSaved={handleCreated} />
      </div>

      <hr className="mb-5 border-gray-100" />

      {/* Configured Providers */}
      <div>
        <h3 className="mb-3 text-xs font-semibold tracking-widest text-gray-400 uppercase">
          Configured Providers
        </h3>

        {configs.length === 0 ? (
          <p className="py-4 text-center text-sm text-gray-400">No providers configured yet.</p>
        ) : (
          <div className="divide-y divide-gray-100">
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
