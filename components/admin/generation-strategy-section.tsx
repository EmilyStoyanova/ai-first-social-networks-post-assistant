"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

/**
 * The site-wide generation default and the single-vs-multi experiment.
 *
 * Deliberately the minimum this phase needs: a default toggle, an experiment
 * on/off, and — only because the settings model already carries it — an
 * allocation percent. There is no analytics view here; the A/B dashboard is a
 * later phase. This screen's whole job is to let an admin choose what the site
 * does by default and whether an experiment is running.
 */

export interface GenerationStrategySettingsView {
  defaultStrategy: "single" | "multi";
  experimentEnabled: boolean;
  experimentKey: string | null;
  experimentAllocationPercent: number;
  updatedAt: string | null;
}

interface Props {
  initialSettings: GenerationStrategySettingsView;
}

export function GenerationStrategySection({ initialSettings }: Props) {
  const t = useTranslations("admin.generationStrategy");
  const [settings, setSettings] = useState(initialSettings);
  const [draft, setDraft] = useState(initialSettings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const dirty =
    draft.defaultStrategy !== settings.defaultStrategy ||
    draft.experimentEnabled !== settings.experimentEnabled ||
    draft.experimentAllocationPercent !== settings.experimentAllocationPercent;

  async function save() {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/v1/admin/generation-strategy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          defaultStrategy: draft.defaultStrategy,
          experimentEnabled: draft.experimentEnabled,
          experimentAllocationPercent: draft.experimentAllocationPercent,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json?.error?.message ?? t("saveError"));
        return;
      }
      setSettings(json.settings);
      setDraft(json.settings);
    } catch {
      setError(t("saveError"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="px-6 py-6">
      <div className="mb-4">
        <h2 className="text-fg text-sm font-semibold">{t("title")}</h2>
        <p className="text-fg-muted mt-1 text-sm">{t("hint")}</p>
      </div>

      <div className="space-y-5">
        <label className="block">
          <span className="text-fg text-sm font-medium">{t("defaultLabel")}</span>
          <p className="text-fg-muted mt-0.5 text-xs">{t("defaultHint")}</p>
          <select
            className="border-border bg-surface text-fg rounded-control mt-2 h-9 w-full border px-3 text-sm"
            value={draft.defaultStrategy}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                defaultStrategy: e.target.value as "single" | "multi",
              }))
            }
          >
            <option value="single">{t("single")}</option>
            <option value="multi">{t("multi")}</option>
          </select>
        </label>

        <div className="border-border border-t pt-5">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              className="mt-1"
              checked={draft.experimentEnabled}
              onChange={(e) => setDraft((d) => ({ ...d, experimentEnabled: e.target.checked }))}
            />
            <span>
              <span className="text-fg text-sm font-medium">{t("experimentLabel")}</span>
              <p className="text-fg-muted mt-0.5 text-xs">{t("experimentHint")}</p>
            </span>
          </label>

          {draft.experimentEnabled && (
            <label className="mt-4 block">
              <span className="text-fg text-sm font-medium">{t("allocationLabel")}</span>
              <p className="text-fg-muted mt-0.5 text-xs">{t("allocationHint")}</p>
              <input
                type="number"
                min={0}
                max={100}
                className="border-border bg-surface text-fg rounded-control mt-2 h-9 w-24 border px-3 text-sm"
                value={draft.experimentAllocationPercent}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    experimentAllocationPercent: Number(e.target.value),
                  }))
                }
              />
            </label>
          )}

          {settings.experimentKey && (
            <p className="text-fg-muted mt-3 text-xs">
              {t("experimentKeyLabel")}: <code>{settings.experimentKey}</code>
            </p>
          )}
        </div>

        {error && <p className="text-danger text-sm">{error}</p>}

        <div className="flex items-center gap-3">
          <Button onClick={save} disabled={!dirty || saving} loading={saving}>
            {t("save")}
          </Button>
          {dirty && !saving && <span className="text-fg-muted text-xs">{t("unsaved")}</span>}
        </div>
      </div>
    </Card>
  );
}
