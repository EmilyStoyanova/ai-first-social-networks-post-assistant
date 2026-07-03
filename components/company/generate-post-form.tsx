"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useApiErrorMessage } from "@/lib/i18n/api-error";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import type { PostItem } from "@/lib/services/company/list-posts.service";
import type { GenerationWarnings } from "@/lib/services/ai/generate-draft-post.service";

const CHANNELS = [
  { value: "FACEBOOK", label: "Facebook" },
  { value: "LINKEDIN", label: "LinkedIn" },
  { value: "INSTAGRAM", label: "Instagram" },
  { value: "TIKTOK", label: "TikTok" },
] as const;

type Channel = (typeof CHANNELS)[number]["value"];

interface Props {
  slug: string;
  onGenerated: (post: PostItem) => void;
}

export function GeneratePostForm({ slug, onGenerated }: Props) {
  const t = useTranslations("posts.generate");
  const tCommon = useTranslations("common");
  const apiError = useApiErrorMessage();
  const [channel, setChannel] = useState<Channel>("FACEBOOK");
  const [contentLanguage, setContentLanguage] = useState<"en" | "bg">("en");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<GenerationWarnings | null>(null);

  async function handleGenerate() {
    setGenerating(true);
    setError("");
    setWarnings(null);
    try {
      const res = await fetch(`/api/v1/companies/${slug}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, contentLanguage }),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(apiError(json.error));
      }
      const json = (await res.json()) as { post: PostItem; warnings: GenerationWarnings };
      onGenerated(json.post);
      if (json.warnings.duplicate.flagged || json.warnings.safety.flagged) {
        setWarnings(json.warnings);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white px-5 py-5 shadow-sm">
      <h3 className="mb-4 text-sm font-semibold text-gray-900">{t("title")}</h3>

      {error && (
        <Alert variant="error" className="mb-4">
          {error}
        </Alert>
      )}

      {warnings?.duplicate.flagged && (
        <Alert variant="warning" className="mb-3">
          {t("duplicateWarning", { score: warnings.duplicate.similarityScore?.toFixed(2) ?? "0" })}
        </Alert>
      )}

      {warnings?.safety.flagged && (
        <Alert variant="warning" className="mb-3">
          {t("safetyWarning", { terms: warnings.safety.matchedTerms.join(", ") })}
        </Alert>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[160px] flex-1">
          <label
            htmlFor="generate-channel"
            className="mb-1.5 block text-sm font-medium text-gray-700"
          >
            {t("channel")}
          </label>
          <select
            id="generate-channel"
            value={channel}
            onChange={(e) => {
              setChannel(e.target.value as Channel);
              setWarnings(null);
            }}
            disabled={generating}
            className="w-full rounded-lg border border-gray-300 bg-white px-3.5 py-2.5 text-sm transition-all duration-200 outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100 focus:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {CHANNELS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>

        <div className="min-w-[140px]">
          <label
            htmlFor="generate-content-language"
            className="mb-1.5 block text-sm font-medium text-gray-700"
          >
            {t("contentLanguage")}
          </label>
          <select
            id="generate-content-language"
            value={contentLanguage}
            onChange={(e) => setContentLanguage(e.target.value as "en" | "bg")}
            disabled={generating}
            className="w-full rounded-lg border border-gray-300 bg-white px-3.5 py-2.5 text-sm transition-all duration-200 outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100 focus:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <option value="en">{t("contentLanguageEN")}</option>
            <option value="bg">{t("contentLanguageBG")}</option>
          </select>
        </div>

        <Button variant="primary" loading={generating} onClick={handleGenerate}>
          {generating ? t("generating") : t("generateDraft")}
        </Button>
      </div>
    </div>
  );
}
