"use client";

import { Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  COMPETITOR_SOCIAL_PLATFORMS,
  type CompetitorSocialProfileInput,
} from "@/lib/validators/competitor.schema";

interface Props {
  profiles: CompetitorSocialProfileInput[];
  onChange: (next: CompetitorSocialProfileInput[]) => void;
  disabled?: boolean;
}

const FIELD =
  "text-body rounded-control border-border-strong bg-surface text-fg h-9 border px-3 outline-none transition-all duration-fast focus:border-accent focus:ring-2 focus:ring-accent/20 focus:ring-offset-0";

/**
 * A competitor's social profiles (§3.4/§10; §1 of the social-analysis
 * correction). A competitor may have several profiles on the same platform,
 * so this is a plain repeatable list — whole-list replace on save (see
 * update-competitor.service.ts), not a per-row API. Part 3A performs no
 * fetch/scrape/sync of any profile added here — every one is created with
 * collection disabled (the schema default), never surfaced as configured.
 */
export function CompetitorSocialProfilesEditor({ profiles, onChange, disabled }: Props) {
  const t = useTranslations("competitiveAnalysis.competitors.socialProfiles");

  function update(index: number, patch: Partial<CompetitorSocialProfileInput>) {
    onChange(profiles.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  }

  function remove(index: number) {
    onChange(profiles.filter((_, i) => i !== index));
  }

  function add() {
    onChange([...profiles, { platform: "facebook", url: "", label: "" }]);
  }

  return (
    <div>
      <label className="text-fg-muted mb-1.5 block text-sm font-medium">{t("title")}</label>
      <p className="text-fg-faint mb-2 text-xs">{t("hint")}</p>

      {profiles.length === 0 && <p className="text-fg-faint mb-2 text-xs">{t("empty")}</p>}

      <div className="space-y-2">
        {profiles.map((profile, index) => (
          <div key={profile.id ?? `new-${index}`} className="flex flex-wrap items-center gap-2">
            <select
              value={profile.platform}
              onChange={(e) =>
                update(index, {
                  platform: e.target.value as CompetitorSocialProfileInput["platform"],
                })
              }
              disabled={disabled}
              className={`${FIELD} w-36 shrink-0`}
            >
              {COMPETITOR_SOCIAL_PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {t(`platforms.${p}`)}
                </option>
              ))}
            </select>
            <input
              type="url"
              value={profile.url}
              onChange={(e) => update(index, { url: e.target.value })}
              placeholder="https://…"
              disabled={disabled}
              className={`${FIELD} min-w-0 flex-1`}
            />
            <input
              type="text"
              value={profile.label ?? ""}
              onChange={(e) => update(index, { label: e.target.value })}
              placeholder={t("labelPlaceholder")}
              disabled={disabled}
              className={`${FIELD} w-32 shrink-0`}
            />
            {!disabled && (
              <button
                type="button"
                onClick={() => remove(index)}
                aria-label={t("remove")}
                className="text-fg-faint hover:text-status-danger-fg duration-fast h-9 shrink-0 px-1 transition-colors"
              >
                <Trash2 size={16} aria-hidden="true" />
              </button>
            )}
          </div>
        ))}
      </div>

      {!disabled && (
        <button
          type="button"
          onClick={add}
          className="text-accent hover:text-fg duration-fast mt-2 inline-flex items-center gap-1 text-sm font-medium transition-colors"
        >
          <Plus size={14} aria-hidden="true" />
          {t("addProfile")}
        </button>
      )}
    </div>
  );
}
