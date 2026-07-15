"use client";

import { useEffect, useState } from "react";
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

/** Three-state override: inherit the source/channel setting, or force on/off. */
type SourceLinkOverride = "inherit" | "include" | "exclude";

/** A selectable LLM returned by GET /companies/[slug]/available-llms (v2-5). */
interface AvailableLlm {
  id: string;
  displayName: string;
  provider: string;
  model: string;
  isDefault: boolean;
}

/** Diagnostics the generate API attaches to a CANNOT_GENERATE_UNIQUE_POST error. */
interface GenerateApiError {
  code?: string;
  message?: string;
  reason?: "jaccard_duplicate" | "semantic_duplicate" | "topic_repeated";
  attempts?: number;
}

/** Maps the abort reason to its reason-specific translation key. */
const UNIQUE_ERROR_KEY: Record<NonNullable<GenerateApiError["reason"]>, string> = {
  topic_repeated: "uniqueErrorTopicRepeated",
  semantic_duplicate: "uniqueErrorSemanticDuplicate",
  jaccard_duplicate: "uniqueErrorJaccardDuplicate",
};

interface Props {
  slug: string;
  onGenerated: (post: PostItem) => void;
  /** Whether generation is based on an RSS feed item — gates the source-link override. */
  hasRssFeedItems: boolean;
}

export function GeneratePostForm({ slug, onGenerated, hasRssFeedItems }: Props) {
  const t = useTranslations("posts.generate");
  const tCommon = useTranslations("common");
  const apiError = useApiErrorMessage();
  const [channel, setChannel] = useState<Channel>("FACEBOOK");
  const [contentLanguage, setContentLanguage] = useState<"en" | "bg">("en");
  const [sourceLinkOverride, setSourceLinkOverride] = useState<SourceLinkOverride>("inherit");
  // Empty string = "System default (auto)"; otherwise an LlmConfig id (v2-5).
  const [llmConfigId, setLlmConfigId] = useState("");
  const [availableLlms, setAvailableLlms] = useState<AvailableLlm[]>([]);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<GenerationWarnings | null>(null);

  // Load the company's selectable LLMs once. Failure is silent — the dropdown
  // simply stays at "System default", preserving the pre-v2-5 behaviour.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/v1/companies/${slug}/available-llms`);
        if (!res.ok) return;
        const json = (await res.json()) as { data?: AvailableLlm[] };
        if (!cancelled && Array.isArray(json.data)) setAvailableLlms(json.data);
      } catch {
        // Non-fatal: leave the dropdown at the system default.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  /**
   * Resolves a generate-API error to a user-facing message. A uniqueness abort
   * (CANNOT_GENERATE_UNIQUE_POST) gets a reason-specific explanation that names
   * how many attempts were made; everything else uses the generic code mapping.
   */
  function resolveGenerateError(err?: GenerateApiError): string {
    if (err?.code === "CANNOT_GENERATE_UNIQUE_POST") {
      const key = (err.reason && UNIQUE_ERROR_KEY[err.reason]) ?? "uniqueErrorGeneric";
      return t(key, { attempts: err.attempts ?? 3 });
    }
    return apiError(err);
  }

  async function handleGenerate() {
    setGenerating(true);
    setError("");
    setWarnings(null);
    try {
      const res = await fetch(`/api/v1/companies/${slug}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel,
          contentLanguage,
          ...(hasRssFeedItems && sourceLinkOverride !== "inherit"
            ? { includeSourceLink: sourceLinkOverride === "include" }
            : {}),
          // Omit entirely when "System default" is selected so the server keeps
          // its env-var default provider path unchanged (v2-5).
          ...(llmConfigId ? { llmConfigId } : {}),
        }),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: GenerateApiError };
        throw new Error(resolveGenerateError(json.error));
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
    <div className="rounded-card border-border bg-surface border px-5 py-5 shadow-sm">
      <h3 className="text-fg mb-4 text-sm font-semibold">{t("title")}</h3>

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
            className="text-fg-muted mb-1.5 block text-sm font-medium"
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
            className="rounded-control border-border-strong bg-surface duration-fast focus:border-accent focus:ring-accent/20 w-full border px-3.5 py-2.5 text-sm transition-all outline-none focus:ring-2 focus:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-60"
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
            className="text-fg-muted mb-1.5 block text-sm font-medium"
          >
            {t("contentLanguage")}
          </label>
          <select
            id="generate-content-language"
            value={contentLanguage}
            onChange={(e) => setContentLanguage(e.target.value as "en" | "bg")}
            disabled={generating}
            className="rounded-control border-border-strong bg-surface duration-fast focus:border-accent focus:ring-accent/20 w-full border px-3.5 py-2.5 text-sm transition-all outline-none focus:ring-2 focus:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <option value="en">{t("contentLanguageEN")}</option>
            <option value="bg">{t("contentLanguageBG")}</option>
          </select>
        </div>

        {hasRssFeedItems && (
          <div className="min-w-[180px]">
            <label
              htmlFor="generate-source-link"
              className="text-fg-muted mb-1.5 block text-sm font-medium"
            >
              {t("sourceLink")}
            </label>
            <select
              id="generate-source-link"
              value={sourceLinkOverride}
              onChange={(e) => setSourceLinkOverride(e.target.value as SourceLinkOverride)}
              disabled={generating}
              className="rounded-control border-border-strong bg-surface duration-fast focus:border-accent focus:ring-accent/20 w-full border px-3.5 py-2.5 text-sm transition-all outline-none focus:ring-2 focus:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="inherit">{t("sourceLinkInherit")}</option>
              <option value="include">{t("sourceLinkInclude")}</option>
              <option value="exclude">{t("sourceLinkExclude")}</option>
            </select>
          </div>
        )}

        {availableLlms.length > 0 && (
          <div className="min-w-[200px]">
            <label
              htmlFor="generate-llm"
              className="text-fg-muted mb-1.5 block text-sm font-medium"
            >
              {t("llm")}
            </label>
            <select
              id="generate-llm"
              value={llmConfigId}
              onChange={(e) => setLlmConfigId(e.target.value)}
              disabled={generating}
              className="rounded-control border-border-strong bg-surface duration-fast focus:border-accent focus:ring-accent/20 w-full border px-3.5 py-2.5 text-sm transition-all outline-none focus:ring-2 focus:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="">{t("llmSystemDefault")}</option>
              {availableLlms.map((llm) => (
                <option key={llm.id} value={llm.id}>
                  {llm.displayName}
                  {llm.isDefault ? " ★" : ""}
                </option>
              ))}
            </select>
          </div>
        )}

        <Button variant="primary" loading={generating} onClick={handleGenerate}>
          {generating ? t("generating") : t("generateDraft")}
        </Button>
      </div>
    </div>
  );
}
