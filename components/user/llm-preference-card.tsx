"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/Card";
import { Alert } from "@/components/ui/Alert";

/** A selectable LLM (secret-scrubbed) returned by GET /me/llm-preference. */
interface AvailableLlm {
  id: string;
  displayName: string;
  isDefault: boolean;
  isPreferred: boolean;
}

interface Props {
  llms: AvailableLlm[];
  /** The effective saved preference ("" = system default). */
  preferredLlmConfigId: string | null;
}

export function LlmPreferenceCard({ llms, preferredLlmConfigId }: Props) {
  const t = useTranslations("settings.preferredLlm");
  const [value, setValue] = useState(preferredLlmConfigId ?? "");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  async function handleChange(next: string) {
    const previous = value;
    setValue(next);
    setStatus("saving");
    try {
      const res = await fetch("/api/v1/me/llm-preference", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // Empty string = system default → clear the preference (null).
        body: JSON.stringify({ llmConfigId: next === "" ? null : next }),
      });
      if (!res.ok) throw new Error("save failed");
      setStatus("saved");
    } catch {
      // Roll back the visible selection so it matches the persisted state.
      setValue(previous);
      setStatus("error");
    }
  }

  return (
    <Card className="px-6 py-6">
      <div className="mb-4">
        <h2 className="text-fg text-sm font-semibold">{t("title")}</h2>
        <p className="text-fg-muted mt-1 text-sm">{t("description")}</p>
      </div>

      <div className="max-w-sm">
        <label htmlFor="preferred-llm" className="text-fg-muted mb-1.5 block text-sm font-medium">
          {t("label")}
        </label>
        <select
          id="preferred-llm"
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          disabled={status === "saving"}
          className="rounded-control border-border-strong bg-surface duration-fast focus:border-accent focus:ring-accent/20 w-full border px-3.5 py-2.5 text-sm transition-all outline-none focus:ring-2 focus:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <option value="">{t("systemDefault")}</option>
          {llms.map((llm) => (
            <option key={llm.id} value={llm.id}>
              {llm.displayName}
              {llm.isDefault ? " ★" : ""}
            </option>
          ))}
        </select>

        {status === "saved" && <p className="text-status-success-fg mt-2 text-xs">{t("saved")}</p>}
        {status === "error" && (
          <Alert variant="error" className="mt-2">
            {t("saveError")}
          </Alert>
        )}
      </div>
    </Card>
  );
}
