"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useApiErrorMessage } from "@/lib/i18n/api-error";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import type { ContentMixDTO } from "@/lib/services/company/get-content-mix.service";

const BASE =
  "rounded-control border px-3 py-1.5 text-sm outline-none transition-all duration-fast focus:ring-2 focus:ring-offset-0";
const NORMAL = "border-border-strong bg-surface focus:border-accent focus:ring-accent/20";
const INVALID = "border-status-danger-dot bg-surface focus:border-status-danger-dot";

interface Props {
  slug: string;
  initialMix: ContentMixDTO;
  canManage: boolean;
}

/** Quota inputs are held as strings so a field can be emptied while typing. */
type Draft = Record<string, string>;

/** Sentinel key for the company-content row; sources are keyed by their id. */
const COMPANY_KEY = "__company__";

function toDraft(mix: ContentMixDTO): Draft {
  const draft: Draft = {
    [COMPANY_KEY]: mix.companyContentPostsPerWeek?.toString() ?? "",
  };
  for (const source of mix.sources) {
    if (!source.enabled) continue;
    draft[source.id] = source.postsPerWeek?.toString() ?? "";
  }
  return draft;
}

/** "" → null (no quota). A non-numeric value → null so it reads as unassigned. */
function parseQuota(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export function ContentMixSection({ slug, initialMix, canManage }: Props) {
  const t = useTranslations("contentMix");
  const tCommon = useTranslations("common");
  const apiError = useApiErrorMessage();

  const [mix, setMix] = useState(initialMix);
  const [draft, setDraft] = useState<Draft>(() => toDraft(initialMix));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const enabledSources = useMemo(() => mix.sources.filter((s) => s.enabled), [mix.sources]);
  const disabledSources = useMemo(() => mix.sources.filter((s) => !s.enabled), [mix.sources]);

  // Live totals mirror the server's rule (sum of quotas vs the weekly target) so
  // the number on screen is the same one the API will check on save.
  const total = useMemo(() => {
    let sum = parseQuota(draft[COMPANY_KEY]) ?? 0;
    for (const source of enabledSources) sum += parseQuota(draft[source.id]) ?? 0;
    return sum;
  }, [draft, enabledSources]);

  const configured = useMemo(
    () =>
      parseQuota(draft[COMPANY_KEY]) !== null ||
      enabledSources.some((s) => parseQuota(draft[s.id]) !== null),
    [draft, enabledSources]
  );

  const unassigned = useMemo(
    () => configured && enabledSources.some((s) => parseQuota(draft[s.id]) === null),
    [configured, draft, enabledSources]
  );

  const remaining = mix.weeklyTarget === null ? null : mix.weeklyTarget - total;
  const balanced = remaining === 0;
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(toDraft(mix)), [draft, mix]);

  // An unconfigured mix is always saveable — it is the "clear the mix" action.
  const canSave = canManage && dirty && !saving && (!configured || (balanced && !unassigned));

  function setValue(key: string, value: string) {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
    setError("");
  }

  async function handleSave() {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const res = await fetch(`/api/v1/companies/${slug}/content-mix`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sources: enabledSources.map((s) => ({
            sourceId: s.id,
            postsPerWeek: parseQuota(draft[s.id]),
          })),
          companyContentPostsPerWeek: parseQuota(draft[COMPANY_KEY]),
        }),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { code?: string; message?: string } };
        throw new Error(apiError(json.error));
      }
      const json = (await res.json()) as { mix: ContentMixDTO };
      setMix(json.mix);
      setDraft(toDraft(json.mix));
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setSaving(false);
    }
  }

  function handleClear() {
    const cleared: Draft = { [COMPANY_KEY]: "" };
    for (const source of enabledSources) cleared[source.id] = "";
    setDraft(cleared);
    setSaved(false);
    setError("");
  }

  const rows: Array<{ key: string; label: string; hint?: string }> = [
    ...enabledSources.map((s) => ({ key: s.id, label: s.name })),
    { key: COMPANY_KEY, label: t("companyContent"), hint: t("companyContentHint") },
  ];

  return (
    <div className="rounded-card border-border bg-surface border px-5 py-5 shadow-sm">
      <h3 className="text-fg text-sm font-semibold">{t("title")}</h3>
      <p className="text-fg-muted mt-1 text-xs">{t("description")}</p>

      {/* Weekly target — the number every quota must add up to. */}
      <div className="border-border mt-4 flex items-baseline justify-between border-b pb-3">
        <span className="text-fg-muted text-sm font-medium">{t("weeklyTarget")}</span>
        <span className="text-fg text-sm font-semibold">
          {mix.weeklyTarget === null ? "—" : t("postsCount", { count: mix.weeklyTarget })}
        </span>
      </div>

      {mix.weeklyTarget === null && mix.channelTargets.length === 0 && (
        <Alert variant="info" className="mt-4">
          {t("noTarget")}
        </Alert>
      )}

      {/* Enabled channels disagree — one recipe cannot serve two budgets. */}
      {mix.weeklyTarget === null && mix.channelTargets.length > 0 && (
        <Alert variant="warning" className="mt-4">
          {t("targetsDiffer", {
            detail: mix.channelTargets.map((c) => `${c.channel} ${c.postsPerWeek}`).join(", "),
          })}
        </Alert>
      )}

      {/* Distribution rows */}
      <div className="mt-4 space-y-2">
        {rows.map((row) => (
          <div key={row.key} className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <span className="text-fg block truncate text-sm">{row.label}</span>
              {row.hint && <span className="text-fg-faint block text-xs">{row.hint}</span>}
            </div>
            {/* Dotted leader, as in the spec's sketch. */}
            <span
              aria-hidden="true"
              className="border-border min-w-6 flex-1 border-b border-dotted"
            />
            <input
              type="number"
              min={0}
              max={mix.maxPostsPerWeek}
              inputMode="numeric"
              aria-label={row.label}
              placeholder={t("unassigned")}
              disabled={!canManage || saving}
              value={draft[row.key] ?? ""}
              onChange={(e) => setValue(row.key, e.target.value)}
              className={`${BASE} ${
                configured && parseQuota(draft[row.key]) === null ? INVALID : NORMAL
              } w-24 text-right disabled:opacity-60`}
            />
          </div>
        ))}
      </div>

      {/* Live total and remaining — the running answer to "does this add up?" */}
      <div className="border-border mt-4 flex items-baseline justify-between border-t pt-3">
        <span className="text-fg-muted text-sm font-medium">
          {remaining === null || !configured
            ? t("remaining")
            : balanced
              ? t("balanced")
              : remaining > 0
                ? t("remaining")
                : t("over", { count: Math.abs(remaining) })}
        </span>
        <span
          className={`text-sm font-semibold ${
            !configured || remaining === null
              ? "text-fg-muted"
              : balanced
                ? "text-status-success-dot"
                : "text-status-danger-dot"
          }`}
        >
          {remaining === null || !configured ? "—" : balanced ? "0" : Math.abs(remaining)}
        </span>
      </div>

      {unassigned && (
        <p className="text-status-danger-dot mt-2 text-xs">
          {apiError({ code: "MIX_SOURCE_UNASSIGNED" })}
        </p>
      )}

      {disabledSources.length > 0 && (
        <p className="text-fg-faint mt-3 text-xs">
          {t("disabledHint")} {disabledSources.map((s) => s.name).join(", ")}
        </p>
      )}

      <p className="text-fg-faint mt-3 text-xs">{t("exhaustedNote")}</p>

      {configured ? (
        mix.channelTargets.length > 1 && (
          <p className="text-fg-faint mt-1 text-xs">
            {t("appliesToChannels", {
              channels: mix.channelTargets.map((c) => c.channel).join(", "),
            })}
          </p>
        )
      ) : (
        <p className="text-fg-muted mt-3 text-xs">{t("unconfigured")}</p>
      )}

      {/* A mix stored before a channel budget changed can be invalid on load. */}
      {mix.validationError && !dirty && (
        <Alert variant="warning" className="mt-4">
          {apiError({ code: mix.validationError.code })}
        </Alert>
      )}

      {error && (
        <Alert variant="error" className="mt-4">
          {error}
        </Alert>
      )}

      {saved && (
        <Alert variant="success" className="mt-4">
          {t("saved")}
        </Alert>
      )}

      {canManage ? (
        <div className="mt-4 flex gap-2">
          <Button variant="primary" size="sm" disabled={!canSave} onClick={handleSave}>
            {saving ? t("saving") : t("save")}
          </Button>
          {dirty && (
            <Button
              variant="secondary"
              size="sm"
              disabled={saving}
              onClick={() => setDraft(toDraft(mix))}
            >
              {t("reset")}
            </Button>
          )}
          {configured && (
            <Button variant="secondary" size="sm" disabled={saving} onClick={handleClear}>
              {t("clear")}
            </Button>
          )}
        </div>
      ) : (
        <p className="text-fg-faint mt-4 text-xs">{t("ownersOnly")}</p>
      )}

      {canManage && configured && <p className="text-fg-faint mt-2 text-xs">{t("clearHint")}</p>}
    </div>
  );
}
