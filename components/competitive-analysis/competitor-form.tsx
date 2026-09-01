"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { CompetitorSocialProfilesEditor } from "./competitor-social-profiles-editor";
import type { CompetitorListItem } from "@/lib/services/competitive-analysis/competitor-dto";
import type {
  CompetitorInput,
  CompetitorSocialProfileInput,
} from "@/lib/validators/competitor.schema";

interface Props {
  initialData?: CompetitorListItem;
  saving: boolean;
  onSave: (data: CompetitorInput) => void;
  onCancel: () => void;
}

const BASE =
  "w-full rounded-control border px-3.5 py-2.5 text-sm outline-none transition-all duration-fast focus:ring-2 focus:ring-offset-0";
const NORMAL = "border-border-strong bg-surface focus:border-accent focus:ring-accent/20";

export function CompetitorForm({ initialData, saving, onSave, onCancel }: Props) {
  const t = useTranslations("competitiveAnalysis.competitors");
  const tCommon = useTranslations("common");

  const [name, setName] = useState(initialData?.name ?? "");
  const [country, setCountry] = useState(initialData?.country ?? "");
  const [website, setWebsite] = useState(initialData?.website ?? "");
  const [notes, setNotes] = useState(initialData?.notes ?? "");
  const [socialProfiles, setSocialProfiles] = useState<CompetitorSocialProfileInput[]>(
    initialData?.socialProfiles.map((p) => ({
      id: p.id,
      platform: p.platform as CompetitorSocialProfileInput["platform"],
      url: p.url,
      label: p.label ?? "",
    })) ?? []
  );
  const [error, setError] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError(t("errors.nameRequired"));
      return;
    }
    setError("");
    onSave({
      name: name.trim(),
      country: country.trim() || undefined,
      website: website.trim() || undefined,
      notes: notes.trim() || undefined,
      socialProfiles: socialProfiles
        .filter((p) => p.url.trim().length > 0)
        .map((p) => ({ ...p, url: p.url.trim(), label: p.label?.trim() || undefined })),
    });
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      {error && <p className="text-status-danger-fg text-xs">{error}</p>}

      <div>
        <label className="text-fg-muted mb-1.5 block text-sm font-medium">{t("fields.name")}</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("fields.namePlaceholder")}
          className={`${BASE} ${NORMAL}`}
          required
          maxLength={200}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="text-fg-muted mb-1.5 block text-sm font-medium">
            {t("fields.country")}
          </label>
          <input
            type="text"
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            placeholder={t("fields.countryPlaceholder")}
            className={`${BASE} ${NORMAL}`}
            maxLength={200}
          />
        </div>
        <div>
          <label className="text-fg-muted mb-1.5 block text-sm font-medium">
            {t("fields.website")}
          </label>
          <input
            type="url"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            placeholder="https://example.com"
            className={`${BASE} ${NORMAL}`}
          />
        </div>
      </div>

      <div>
        <label className="text-fg-muted mb-1.5 block text-sm font-medium">
          {t("fields.notes")}
        </label>
        <textarea
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={t("fields.notesPlaceholder")}
          className={`${BASE} ${NORMAL} resize-none`}
          maxLength={5000}
        />
      </div>

      <CompetitorSocialProfilesEditor profiles={socialProfiles} onChange={setSocialProfiles} />

      <div className="flex gap-2 pt-1">
        <Button type="submit" variant="primary" size="sm" loading={saving}>
          {saving ? tCommon("saving") : tCommon("save")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          {tCommon("cancel")}
        </Button>
      </div>
    </form>
  );
}
