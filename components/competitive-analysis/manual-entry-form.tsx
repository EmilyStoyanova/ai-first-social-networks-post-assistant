"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useApiErrorMessage } from "@/lib/i18n/api-error";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import {
  COMPETITOR_MANUAL_SOURCE_TYPES,
  COMPETITOR_MANUAL_POST_TYPES,
} from "@/lib/validators/competitor-manual-entry.schema";
import type { ManualEntryItem } from "@/lib/services/competitive-analysis/create-manual-entry.service";

const FIELD =
  "text-body rounded-control border-border-strong bg-surface text-fg h-9 border px-3 outline-none transition-all duration-fast focus:border-accent focus:ring-2 focus:ring-accent/20 focus:ring-offset-0";

interface Props {
  slug: string;
  competitors: Array<{ id: string; name: string }>;
  onCreated: (entry: ManualEntryItem) => void;
  onCancel: () => void;
}

/**
 * Manual competitor content import (Part 3B §5/§17). The `url` field is
 * captioned as reference-only — this form never fetches it, and neither does
 * the service it posts to (see `no-social-fetch.test.ts`). `capturedAt` is
 * left blank when the person does not know it; nothing here defaults it to
 * today (§6).
 */
export function ManualEntryForm({ slug, competitors, onCreated, onCancel }: Props) {
  const t = useTranslations("competitiveAnalysis.content.manualEntry");
  const tPlatforms = useTranslations("competitiveAnalysis.competitors.socialProfiles.platforms");
  const tCommon = useTranslations("common");
  const apiError = useApiErrorMessage();

  const [competitorId, setCompetitorId] = useState(competitors[0]?.id ?? "");
  const [sourceType, setSourceType] =
    useState<(typeof COMPETITOR_MANUAL_SOURCE_TYPES)[number]>("facebook");
  const [postType, setPostType] =
    useState<(typeof COMPETITOR_MANUAL_POST_TYPES)[number]>("organic");
  const [url, setUrl] = useState("");
  const [content, setContent] = useState("");
  const [capturedAt, setCapturedAt] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!competitorId) {
      setError(t("errors.competitorRequired"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      const res = await fetch(
        `/api/v1/companies/${slug}/competitive-analysis/competitors/${competitorId}/manual-entries`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sourceType,
            postType,
            url: url.trim() || undefined,
            content,
            capturedAt: capturedAt || undefined,
          }),
        }
      );
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(apiError(json.error));
      }
      const json = (await res.json()) as { entry: ManualEntryItem };
      onCreated(json.entry);
    } catch (err) {
      setError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3">
      {error && (
        <Alert variant="error" className="text-xs">
          {error}
        </Alert>
      )}

      <div>
        <label className="text-fg-muted mb-1 block text-sm font-medium">{t("competitor")}</label>
        <select
          value={competitorId}
          onChange={(e) => setCompetitorId(e.target.value)}
          className={`${FIELD} w-full`}
          required
        >
          {competitors.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex gap-3">
        <div className="flex-1">
          <label className="text-fg-muted mb-1 block text-sm font-medium">{t("platform")}</label>
          <select
            value={sourceType}
            onChange={(e) =>
              setSourceType(e.target.value as (typeof COMPETITOR_MANUAL_SOURCE_TYPES)[number])
            }
            className={`${FIELD} w-full`}
          >
            {COMPETITOR_MANUAL_SOURCE_TYPES.map((s) => (
              <option key={s} value={s}>
                {s === "website" || s === "other" ? t(`sourceTypes.${s}`) : tPlatforms(s)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex-1">
          <label className="text-fg-muted mb-1 block text-sm font-medium">{t("postType")}</label>
          <select
            value={postType}
            onChange={(e) =>
              setPostType(e.target.value as (typeof COMPETITOR_MANUAL_POST_TYPES)[number])
            }
            className={`${FIELD} w-full`}
          >
            {COMPETITOR_MANUAL_POST_TYPES.map((p) => (
              <option key={p} value={p}>
                {t(`postTypes.${p}`)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="text-fg-muted mb-1 block text-sm font-medium">{t("content")}</label>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          required
          rows={5}
          placeholder={t("contentPlaceholder")}
          className="text-body rounded-control border-border-strong bg-surface text-fg focus:border-accent focus:ring-accent/20 duration-fast w-full resize-y border px-3 py-2 transition-all outline-none focus:ring-2 focus:ring-offset-0"
        />
      </div>

      <div className="flex gap-3">
        <div className="flex-1">
          <label className="text-fg-muted mb-1 block text-sm font-medium">{t("url")}</label>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
            className={`${FIELD} w-full`}
          />
          <p className="text-fg-faint mt-1 text-xs">{t("urlHint")}</p>
        </div>
        <div className="flex-1">
          <label className="text-fg-muted mb-1 block text-sm font-medium">{t("capturedAt")}</label>
          <input
            type="date"
            value={capturedAt}
            onChange={(e) => setCapturedAt(e.target.value)}
            className={`${FIELD} w-full`}
          />
          <p className="text-fg-faint mt-1 text-xs">{t("capturedAtHint")}</p>
        </div>
      </div>

      <div className="flex gap-2 pt-1">
        <Button type="submit" variant="primary" size="sm" loading={saving}>
          {tCommon("save")}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {tCommon("cancel")}
        </Button>
      </div>
    </form>
  );
}
